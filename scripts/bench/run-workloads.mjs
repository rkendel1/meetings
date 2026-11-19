// Workload benchmark for one deployment of Meetings. Drives real browsers (Playwright Chromium, fake camera and
// microphone, real accounts signed up through FeltKit's built-in accounts) against the deployment, and samples the
// deployment's server process from /proc. Writes machine-readable results (one JSON file) and prints a summary.
//
//   node scripts/bench/run-workloads.mjs --target http://localhost:3100 --pid <server pid> --state <state dir> \
//        --out bench-results.json [--scenarios idle,light,small,normal,busy,burst,recovery] [--scale 1]
//
// Every client request goes through a counting TCP proxy started here (application network traffic: HTTP,
// live-query streams, signaling). Media is peer-to-peer between the browsers and never reaches the server; it is
// measured separately from the browsers' own WebRTC stats. --restart "<command>" is how the recovery scenario
// restarts the deployment (it must print nothing required; the new PID is found with --pid-command).
import { createRequire } from "node:module";
import { createServer, connect } from "node:net";
import { readFileSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import os from "node:os";
const { chromium } = createRequire(import.meta.url)("playwright");

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []));
const TARGET = new URL(args.target ?? "http://localhost:3100");
const STATE = args.state;
const OUT = args.out ?? "bench-results.json";
const SCALE = Number(args.scale ?? 1); // multiplies scenario durations
const SCENARIOS = (args.scenarios ?? "idle,light,small,normal,busy,burst,recovery").split(",");
let PID = Number(args.pid);
const TICK = Number(process.env.SAMPLE_MS ?? 1000);
const HZ = Number(execSync("getconf CLK_TCK").toString().trim());

// ---------- counting proxy (application traffic) ----------
const traffic = { connections: 0, bytesToServer: 0, bytesToClients: 0 };
const proxy = createServer((client) => {
  traffic.connections += 1;
  const upstream = connect(Number(TARGET.port || 80), TARGET.hostname);
  client.on("data", (d) => (traffic.bytesToServer += d.length));
  upstream.on("data", (d) => (traffic.bytesToClients += d.length));
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
// The app answers only requests addressed to localhost in development; production accepts its own origin.
const PROXY = `http://localhost:${proxy.address().port}`;

// ---------- process sampling ----------
function proc(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    return { cpuS: (Number(stat[11]) + Number(stat[12])) / HZ, rssMb: rssKb / 1024 };
  } catch {
    return null;
  }
}
function descendants(pid) {
  try {
    return execSync(`ps -o pid= --ppid ${pid}`).toString().split("\n").map((s) => Number(s.trim())).filter(Boolean).flatMap((c) => [c, ...descendants(c)]);
  } catch {
    return [];
  }
}
function treeSample(pid) {
  const all = [pid, ...descendants(pid)].map(proc).filter(Boolean);
  return all.length ? { cpuS: all.reduce((a, s) => a + s.cpuS, 0), rssMb: all.reduce((a, s) => a + s.rssMb, 0), processes: all.length } : null;
}
function dirBytes(dir) {
  if (!dir) return null;
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else total += s.size;
    }
  };
  try {
    walk(dir);
    return total;
  } catch {
    return null;
  }
}

// ---------- browsers and accounts ----------
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
let accountN = 0;
const RUN = Date.now().toString(36);
async function person() {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  await page.goto(PROXY);
  const i = ++accountN;
  await page.evaluate(async ({ i, RUN }) => {
    const h = { "Content-Type": "application/json", "X-FeltKit-Session": "cookie" };
    const s = await (await fetch("/api/session", { headers: h })).json();
    const r = await fetch("/api/auth/signup", { method: "POST", headers: { ...h, ...(s.csrf ? { "X-FeltKit-CSRF": s.csrf } : {}) }, body: JSON.stringify({ email: `bench-${RUN}-${i}@example.test`, password: "correct horse battery staple", name: `Bench ${i}` }) });
    if (!r.ok) throw new Error(`signup ${r.status} ${await r.text()}`);
  }, { i, RUN });
  await page.goto(PROXY);
  await page.getByText("Your meetings").waitFor({ timeout: 30000 });
  return page;
}
async function meeting(host, guests) {
  await host.getByRole("button", { name: "Start a meeting now" }).click();
  await host.waitForURL(/\/m\//);
  const code = host.url().split("/m/")[1];
  await host.getByRole("button", { name: "Start the call" }).click();
  for (const g of guests) {
    await g.goto(`${PROXY}/m/${code}`);
    await g.getByRole("button", { name: "Join now" }).click();
  }
  const n = guests.length + 1;
  const pages = [host, ...guests];
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const ok = (await Promise.all(pages.map((p) => p.evaluate(() => document.querySelectorAll('.tile[data-state="connected"]').length).catch(() => 0)))).every((c) => c === n - 1);
    if (ok) return { code, pages, connectedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { code, pages, connectedMs: null };
}
async function leave(pages) {
  for (const p of pages) await p.getByRole("button", { name: "Leave call" }).click().catch(() => {});
}
async function close(pages) {
  for (const p of pages) await p.context().close().catch(() => {});
}
async function mediaBytes(pages) {
  let sent = 0;
  for (const p of pages) {
    sent += await p.evaluate(async () => {
      let b = 0;
      for (const pc of window.__meetings ? [...window.__meetings.mesh.conns.values()].map((c) => c.pc) : []) {
        (await pc.getStats()).forEach((r) => r.type === "outbound-rtp" && (b += r.bytesSent));
      }
      return b;
    }).catch(() => 0);
  }
  return sent;
}

// ---------- scenario runner ----------
const results = [];
async function scenario(name, definition, body) {
  const s0 = treeSample(PID);
  const t0 = Date.now();
  const tr0 = { ...traffic };
  const st0 = dirBytes(STATE);
  let peakRss = s0?.rssMb ?? 0;
  let samples = 0;
  let rssSum = 0;
  const timer = setInterval(() => {
    const s = treeSample(PID);
    if (s) {
      peakRss = Math.max(peakRss, s.rssMb);
      rssSum += s.rssMb;
      samples += 1;
    }
  }, TICK);
  let outcome = {};
  let error = null;
  try {
    outcome = (await body()) ?? {};
  } catch (e) {
    error = String(e.message ?? e).split("\n")[0];
  }
  clearInterval(timer);
  const s1 = treeSample(PID);
  const durationS = (Date.now() - t0) / 1000;
  const cpuS = s0 && s1 ? s1.cpuS - s0.cpuS : null;
  const row = {
    scenario: name,
    definition,
    period: { start: new Date(t0).toISOString(), end: new Date().toISOString(), durationS: Number(durationS.toFixed(1)) },
    completed: error === null,
    error,
    observed: {
      serverCpuSeconds: { value: cpuS === null ? null : Number(cpuS.toFixed(2)), unit: "CPU-s", source: "/proc/<pid>/stat utime+stime, server process tree" },
      serverCpuAvgCores: { value: cpuS === null ? null : Number((cpuS / durationS).toFixed(4)), unit: "cores", source: "calculated: CPU-s / duration" },
      serverRssAvgMb: { value: samples ? Number((rssSum / samples).toFixed(1)) : null, unit: "MiB", source: `/proc/<pid>/status VmRSS, sampled every ${TICK} ms` },
      serverRssPeakMb: { value: Number(peakRss.toFixed(1)), unit: "MiB", source: "same, maximum" },
      appTrafficToServerBytes: { value: traffic.bytesToServer - tr0.bytesToServer, unit: "bytes", source: "counting TCP proxy in front of the server" },
      appTrafficToClientsBytes: { value: traffic.bytesToClients - tr0.bytesToClients, unit: "bytes", source: "counting TCP proxy" },
      appConnections: { value: traffic.connections - tr0.connections, unit: "TCP connections", source: "counting TCP proxy" },
      stateBytesDelta: { value: st0 === null ? null : dirBytes(STATE) - st0, unit: "bytes", source: "size of the FeltDB state directory before/after" },
      ...Object.fromEntries(Object.entries(outcome).map(([k, v]) => [k, v])),
    },
  };
  results.push(row);
  console.log(`${row.completed ? "✓" : "✗"} ${name} ${durationS.toFixed(0)} s: server ${row.observed.serverCpuSeconds.value} CPU-s (${row.observed.serverCpuAvgCores.value} cores avg), RSS avg ${row.observed.serverRssAvgMb.value} / peak ${row.observed.serverRssPeakMb.value} MiB, traffic ${(row.observed.appTrafficToServerBytes.value / 1024).toFixed(0)} KiB in / ${(row.observed.appTrafficToClientsBytes.value / 1024).toFixed(0)} KiB out${error ? `; ERROR ${error}` : ""}`);
}
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000 * SCALE));
const pm = (participants, seconds) => ({ value: Number(((participants * seconds) / 60).toFixed(2)), unit: "participant-minutes", source: "calculated: participants × seconds in call / 60" });

// ---------- scenarios ----------
const D = { idle: 600, light: 180, small: 180, normal: 180, busy: 180, burst: 120, recovery: 120 };
for (const name of SCENARIOS) {
  if (name === "idle")
    await scenario("idle", `deployed, no clients, ${D.idle * SCALE} s`, async () => {
      await wait(D.idle);
    });
  if (name === "light")
    await scenario("light", `3 signed-in people on the home page (live queries open), no meetings, ${D.light * SCALE} s`, async () => {
      const ps = [await person(), await person(), await person()];
      await wait(D.light);
      await close(ps);
      return { signedInUsers: { value: 3, unit: "users", source: "workload definition" } };
    });
  if (name === "small" || name === "normal") {
    const n = name === "small" ? 2 : 4;
    await scenario(name, `one meeting, ${n} participants, ${D[name] * SCALE} s in call`, async () => {
      const ps = [];
      for (let i = 0; i < n; i++) ps.push(await person());
      const m = await meeting(ps[0], ps.slice(1));
      const t = Date.now();
      await wait(D[name]);
      const inCall = (Date.now() - t) / 1000;
      const media = await mediaBytes(ps);
      await leave(ps);
      await close(ps);
      return { participants: { value: n, unit: "people", source: "workload" }, connectedMs: { value: m.connectedMs, unit: "ms", source: "observed: all tiles connected" }, participantMinutes: pm(n, inCall), meetingMinutes: { value: Number((inCall / 60).toFixed(2)), unit: "meeting-minutes", source: "calculated" }, peerToPeerMediaBytes: { value: media, unit: "bytes", source: "browsers' outbound-rtp bytesSent (never through the server)" } };
    });
  }
  if (name === "busy")
    await scenario("busy", `3 simultaneous meetings × 2 participants, ${D.busy * SCALE} s`, async () => {
      const ms = [];
      for (let k = 0; k < 3; k++) {
        const a = await person();
        const b = await person();
        ms.push(await meeting(a, [b]));
      }
      const t = Date.now();
      await wait(D.busy);
      const inCall = (Date.now() - t) / 1000;
      const all = ms.flatMap((m) => m.pages);
      const media = await mediaBytes(all);
      await leave(all);
      await close(all);
      return { meetings: { value: 3, unit: "meetings", source: "workload" }, participants: { value: 6, unit: "people", source: "workload" }, allConnected: { value: ms.every((m) => m.connectedMs !== null), unit: "bool", source: "observed" }, participantMinutes: pm(6, inCall), meetingMinutes: { value: Number(((3 * inCall) / 60).toFixed(2)), unit: "meeting-minutes", source: "calculated" }, peerToPeerMediaBytes: { value: media, unit: "bytes", source: "browsers' outbound-rtp" } };
    });
  if (name === "burst")
    await scenario("burst", `8 people arrive one after another, form 4 meetings of 2, stay 30 s each, leave`, async () => {
      let participantSeconds = 0;
      let completed = 0;
      const t0 = Date.now();
      await Promise.all([0, 1, 2, 3].map(async (k) => {
        await new Promise((r) => setTimeout(r, k * 5000 * SCALE));
        const a = await person();
        const b = await person();
        const m = await meeting(a, [b]);
        const t = Date.now();
        await wait(30);
        participantSeconds += 2 * ((Date.now() - t) / 1000);
        await leave(m.pages);
        await close(m.pages);
        if (m.connectedMs !== null) completed += 1;
      }));
      return { meetingsCompleted: { value: completed, unit: "meetings of 4", source: "observed" }, participantMinutes: { value: Number((participantSeconds / 60).toFixed(2)), unit: "participant-minutes", source: "calculated" }, burstWallSeconds: { value: Number(((Date.now() - t0) / 1000).toFixed(1)), unit: "s", source: "observed" } };
    });
  if (name === "recovery")
    await scenario("recovery", "a 2-person call; the server process is killed (SIGKILL) and restarted; time until both rejoin and media reconnects", async () => {
      if (!args.restart || !args["pid-command"]) throw new Error("recovery needs --restart and --pid-command");
      const a = await person();
      const b = await person();
      const m = await meeting(a, [b]);
      const killedAt = Date.now();
      try { process.kill(PID, "SIGKILL"); } catch {}
      for (const c of descendants(PID)) try { process.kill(c, "SIGKILL"); } catch {}
      execSync(args.restart, { stdio: "ignore" });
      let healthyMs = null;
      for (let i = 0; i < 600 && healthyMs === null; i++) {
        try {
          const r = await fetch(`${TARGET.origin}/`);
          if (r.ok) healthyMs = Date.now() - killedAt;
        } catch {}
        if (healthyMs === null) await new Promise((r) => setTimeout(r, 100));
      }
      PID = Number(execSync(args["pid-command"]).toString().trim());
      // Clients: both tabs reconnect by themselves (heartbeat → expired → rejoin, live queries reconnect).
      let rejoinedMs = null;
      for (let i = 0; i < 240 && rejoinedMs === null; i++) {
        const ok = (await Promise.all(m.pages.map((p) => p.evaluate(() => document.querySelectorAll('.tile[data-state="connected"]').length).catch(() => 0)))).every((c) => c === 1);
        const room = await Promise.all(m.pages.map((p) => p.locator(".room").count().catch(() => 0)));
        if (ok && room.every((c) => c === 1) && Date.now() - killedAt > 2000) rejoinedMs = Date.now() - killedAt;
        else await new Promise((r) => setTimeout(r, 500));
      }
      await leave(m.pages);
      await close(m.pages);
      return { serverHealthyAfterKillMs: { value: healthyMs, unit: "ms", source: "observed: first 200 on / after SIGKILL + restart" }, callConnectedAgainAfterKillMs: { value: rejoinedMs, unit: "ms", source: "observed: both tabs in a room with the other's tile connected" } };
    });
}
await browser.close();
proxy.close();
const meta = {
  schema: "meetings.bench/1",
  deployment: args.label ?? "unlabelled",
  target: TARGET.origin,
  host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)), kernel: os.release(), node: process.version },
  note: "Browsers run on the same host as the server: they compete for CPU with it. Server figures are for the server process tree only; media is peer-to-peer.",
  scale: SCALE,
};
writeFileSync(OUT, JSON.stringify({ ...meta, results }, null, 2));
console.log(`wrote ${OUT}`);
