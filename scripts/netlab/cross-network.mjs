// One cross-network call: Ada's browser in siteA, Grace's in siteB (scripts/netlab/lab.sh), both on the
// app's real ICE configuration (media:iceServers → the TURN provider). Prints one JSON line:
// { connected, paths: { ada, grace }, video: { ada, grace }, relay } or the failure.
//   ip netns must exist (lab.sh up …); the app must run with the TURN provider configured.
import { createRequire } from "node:module";
import { writeFileSync, chmodSync } from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");

const URL_ = "http://localhost:3000";
const label = process.argv[2] ?? "scenario";
const timeoutMs = Number(process.env.CONNECT_TIMEOUT_MS ?? 30000);

function browserIn(ns) {
  const wrapper = `/tmp/meetings-netlab/chrome-${ns}.sh`;
  // No proxy: the lab's sites reach the internet directly. (A proxy configured in the host's environment
  // would also carry Chrome's TURN-over-TCP connections, and is unreachable from inside a site.)
  writeFileSync(wrapper, `#!/bin/sh\nexec env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy ip netns exec ${ns} ${chromium.executablePath()} --no-proxy-server "$@"\n`);
  chmodSync(wrapper, 0o755);
  return chromium.launch({ executablePath: wrapper, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
}
async function person(browser, user) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.getByLabel("Signed in as").selectOption(user);
  await page.getByText("Your meetings").waitFor();
  return page;
}

const [bA, bB] = await Promise.all([browserIn("siteA"), browserIn("siteB")]);
const out = { scenario: label };
try {
  const ada = await person(bA, "ada");
  const grace = await person(bB, "grace");
  await ada.getByRole("button", { name: "Start a meeting now" }).click();
  await ada.waitForURL(/\/m\//);
  const code = ada.url().split("/m/")[1];
  await ada.getByRole("button", { name: "Start the call" }).click();
  await grace.goto(`${URL_}/m/${code}`);
  await grace.getByRole("button", { name: "Join now" }).click();
  const state = (p, o) => p.locator(`.tile[data-peer="${o}"]`).getAttribute("data-state").catch(() => null);
  const start = Date.now();
  let connected = false;
  while (Date.now() - start < timeoutMs) {
    if ((await state(ada, "grace")) === "connected" && (await state(grace, "ada")) === "connected") {
      connected = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  out.connected = connected;
  out.connectMs = connected ? Date.now() - start : null;
  out.states = { ada: await state(ada, "grace"), grace: await state(grace, "ada") };
  out.relayOffered = await ada.evaluate(() => window.__meetings?.relay ?? null);
  if (connected) {
    await ada.waitForFunction(() => (document.querySelector('.tile[data-peer="grace"] video')?.videoWidth ?? 0) > 0, null, { timeout: 15000 }).catch(() => {});
    await grace.waitForFunction(() => (document.querySelector('.tile[data-peer="ada"] video')?.videoWidth ?? 0) > 0, null, { timeout: 15000 }).catch(() => {});
    out.video = {
      adaSeesGrace: await ada.evaluate(() => document.querySelector('.tile[data-peer="grace"] video')?.videoWidth ?? 0),
      graceSeesAda: await grace.evaluate(() => document.querySelector('.tile[data-peer="ada"] video')?.videoWidth ?? 0),
    };
    out.paths = { ada: await ada.evaluate(() => window.__meetings.mesh.paths()), grace: await grace.evaluate(() => window.__meetings.mesh.paths()) };
  }
  if (!connected) {
    // Why not: each side's candidates and its candidate pairs.
    const why = (p) => p.evaluate(async () => {
      const out = { local: [], pairs: [] };
      for (const [, c] of window.__meetings?.mesh?.conns ?? []) {
        const s = await c.pc.getStats();
        s.forEach((r) => {
          if (r.type === "local-candidate") out.local.push(`${r.candidateType}${r.relayProtocol ? "/" + r.relayProtocol : ""}`);
          if (r.type === "candidate-pair") { const l = s.get(r.localCandidateId), rr = s.get(r.remoteCandidateId); out.pairs.push(`${l?.candidateType}→${rr?.candidateType}:${r.state}:${r.requestsSent}/${r.responsesReceived}`); }
        });
      }
      return out;
    }).catch((e) => String(e));
    out.diagnosis = { ada: await why(ada), grace: await why(grace) };
  }
  await ada.getByRole("button", { name: "Leave call" }).click().catch(() => {});
  await grace.getByRole("button", { name: "Leave call" }).click().catch(() => {});
} catch (error) {
  out.error = String(error.message ?? error).split("\n")[0];
} finally {
  await bA.close();
  await bB.close();
}
console.log(JSON.stringify(out));
