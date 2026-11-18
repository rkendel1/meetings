// Call capacity, measured: N people (real accounts, signed up through FeltKit's built-in accounts) in one
// call, for each N given. Prints one line per N and a JSON summary.
//
//   node scripts/capacity.mjs [url] [sizes, default 2,3,4,5,6]
//   WARMUP_MS=15000 SAMPLE_MS=10000 node scripts/capacity.mjs
//
// A call of size N is "usable" when every one of the N·(N−1) directed video streams is connected and
// decoding, at least 10 fps for the worst stream and 15 fps median.
// All participants run on THIS host, so it also measures this host: on separate devices each person carries
// only their own N−1 encodes and decodes. Read the per-person figures (uplink, CPU share) for that case.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import os from "node:os";
const { chromium } = createRequire(import.meta.url)("playwright");

const URL_ = process.argv[2] ?? "http://localhost:3000";
const SIZES = (process.argv[3] ?? "2,3,4,5,6").split(",").map(Number);
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 15000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 10000);

const INSTRUMENT = () => {
  const P = window.RTCPeerConnection;
  let n = 0;
  window.__pcs = [];
  window.RTCPeerConnection = function (cfg) {
    const pc = new P(cfg);
    pc.__id = ++n;
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = P.prototype;
  window.__sample = async () => {
    const out = { outBytes: 0, streams: [] };
    for (const pc of window.__pcs.filter((p) => p.connectionState === "connected")) {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === "outbound-rtp" && r.kind === "video") out.outBytes += r.bytesSent;
        if (r.type === "inbound-rtp" && r.kind === "video") out.streams.push({ id: `${pc.__id}:${r.id}`, frames: r.framesDecoded ?? 0 });
      });
    }
    return out;
  };
};

function cpuTimes() {
  const [, ...f] = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/);
  const n = f.map(Number);
  const idle = n[3] + n[4];
  return { idle, total: n.reduce((a, b) => a + b, 0) };
}

async function signUp(browser, i, run) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.evaluate(async ({ i, run }) => {
    const h = { "Content-Type": "application/json", "X-FeltKit-Session": "cookie" };
    const s = await (await fetch("/api/session", { headers: h })).json();
    const r = await fetch("/api/auth/signup", { method: "POST", headers: { ...h, ...(s.csrf ? { "X-FeltKit-CSRF": s.csrf } : {}) }, body: JSON.stringify({ email: `cap-${run}-${i}@example.test`, password: "correct horse battery staple", name: `Person ${i}` }) });
    if (!r.ok) throw new Error(`signup ${r.status} ${await r.text()}`);
  }, { i, run });
  await page.goto(URL_);
  await page.getByText("Your meetings").waitFor();
  return page;
}

const results = [];
for (const N of SIZES) {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const run = `${Date.now().toString(36)}-${N}`;
  try {
    const pages = [];
    for (let i = 1; i <= N; i++) pages.push(await signUp(browser, i, run));
    const [host, ...rest] = pages;
    await host.getByRole("button", { name: "Start a meeting now" }).click();
    await host.waitForURL(/\/m\//);
    const code = host.url().split("/m/")[1];
    await host.getByRole("button", { name: "Start the call" }).click();
    const t0 = Date.now();
    await Promise.all(rest.map(async (p) => {
      await p.goto(`${URL_}/m/${code}`);
      await p.getByRole("button", { name: "Join now" }).click();
    }));
    // Everyone connected to everyone.
    const connected = async () => (await Promise.all(pages.map((p) => p.evaluate(() => document.querySelectorAll('.tile[data-state="connected"]').length)))).every((c) => c === N - 1);
    let allConnected = false;
    while (Date.now() - t0 < 60000) {
      if (await connected()) {
        allConnected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const connectMs = allConnected ? Date.now() - t0 : null;
    await new Promise((r) => setTimeout(r, WARMUP_MS));
    const c0 = cpuTimes();
    const a = await Promise.all(pages.map((p) => p.evaluate(() => window.__sample())));
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
    const b = await Promise.all(pages.map((p) => p.evaluate(() => window.__sample())));
    const c1 = cpuTimes();
    const s = SAMPLE_MS / 1000;
    const fps = [];
    let uplinkKbps = 0;
    pages.forEach((_, i) => {
      for (const st of b[i].streams) {
        const before = a[i].streams.find((x) => x.id === st.id);
        fps.push(before ? (st.frames - before.frames) / s : 0);
      }
      uplinkKbps += ((b[i].outBytes - a[i].outBytes) * 8) / s / 1000;
    });
    fps.sort((x, y) => x - y);
    const expected = N * (N - 1);
    const median = fps.length ? fps[Math.floor(fps.length / 2)] : 0;
    const row = {
      N,
      connectMs,
      streams: `${fps.filter((f) => f > 0).length}/${expected}`,
      minFps: Number((fps[0] ?? 0).toFixed(1)),
      medianFps: Number(median.toFixed(1)),
      uplinkKbpsPerPerson: Math.round(uplinkKbps / N),
      hostCpu: `${Math.round((1 - (c1.idle - c0.idle) / (c1.total - c0.total)) * 100)}% of ${os.cpus().length} cores`,
    };
    row.usable = allConnected && fps.length === expected && row.minFps >= 10 && row.medianFps >= 15;
    results.push(row);
    console.log(`N=${N}: ${row.usable ? "usable" : "NOT usable"}  connected in ${connectMs ?? "—"} ms, video streams ${row.streams}, fps min ${row.minFps} / median ${row.medianFps}, uplink ${row.uplinkKbpsPerPerson} kbps per person, host CPU ${row.hostCpu}`);
  } catch (error) {
    results.push({ N, error: String(error.message ?? error).split("\n")[0], usable: false });
    console.log(`N=${N}: error ${error.message.split("\n")[0]}`);
  } finally {
    await browser.close();
  }
}
const best = results.filter((r) => r.usable).map((r) => r.N);
console.log(JSON.stringify({ host: { cpus: os.cpus().length, model: os.cpus()[0]?.model }, results, largestUsable: best.length ? Math.max(...best) : 0 }));
