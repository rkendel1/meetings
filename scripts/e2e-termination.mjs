// Media termination after authorization ends, measured in real browsers against `npm run dev`.
//
//   node scripts/e2e-termination.mjs [url]
//
// For each way a participant can lose authorization, it measures:
//   - self:   when the participant's own browser has no open peer connection and no live camera/mic track;
//   - others: when every other browser has closed its peer connection to that participant (no media in
//             either direction can flow once the other side has closed it).
// "adversarial" runs the same case with a participant whose browser ignores close() and track.stop(),
// so only what the server and the other clients enforce remains.
// Bounds: revocation and removal are pushed through live queries (seconds); a session that ends elsewhere
// is detected by the participant's next heartbeat or session re-check (≤ 15 s), and by everyone else when
// that participant's presence expires (≤ 45 s after its last check-in, + up to 15 s until a check-in settles it).
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");

const URL_ = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });

const INSTRUMENT = () => {
  const P = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function (cfg) {
    const pc = new P(cfg);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = P.prototype;
  window.__tracks = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await gum(c);
    window.__tracks.push(...s.getTracks());
    return s;
  };
  window.__media = () => ({
    openPcs: window.__pcs.filter((pc) => pc.connectionState !== "closed" && pc.signalingState !== "closed").length,
    connectedPcs: window.__pcs.filter((pc) => pc.connectionState === "connected").length,
    liveTracks: window.__tracks.filter((t) => t.readyState === "live").length,
  });
  window.__beEvil = () => {
    // A client that ignores the app's attempts to stop: nothing it holds is ever closed or stopped.
    P.prototype.close = function () {};
    MediaStreamTrack.prototype.stop = function () {};
  };
};

async function person(user, ctx) {
  ctx ??= await browser.newContext({ permissions: ["camera", "microphone"] });
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.getByLabel("Signed in as").selectOption(user);
  await page.getByText("Your meetings").waitFor();
  // The first load signs in as the first dev user; wait until the server says this page is `user`.
  await page.waitForFunction(async (u) => (await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json()).principal?.id === u, user, { polling: 250, timeout: 10000 });
  return page;
}
const media = (p) => p.evaluate(() => window.__media());
async function until(fn, timeoutMs, stepMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

async function call() {
  const ada = await person("ada");
  const grace = await person("grace");
  await ada.getByRole("button", { name: "Start a meeting now" }).click();
  await ada.waitForURL(/\/m\//);
  const code = ada.url().split("/m/")[1];
  await ada.getByRole("button", { name: "Start the call" }).click();
  await grace.goto(`${URL_}/m/${code}`);
  await grace.getByRole("button", { name: "Join now" }).click();
  for (const [p, o] of [[ada, "grace"], [grace, "ada"]]) {
    await p.waitForFunction((x) => document.querySelector(`.tile[data-peer="${x}"]`)?.getAttribute("data-state") === "connected", o, { timeout: 25000 });
  }
  assert.deepEqual(await media(grace), { openPcs: 1, connectedPcs: 1, liveTracks: 2 });
  return { ada, grace, code };
}

const results = [];
async function measure(name, { evil = false, act, selfBoundMs, othersBoundMs }) {
  const { ada, grace } = await call();
  if (evil) await grace.evaluate(() => window.__beEvil());
  const t0 = Date.now();
  await act({ ada, grace });
  const actMs = Date.now() - t0;
  const [self, others] = await Promise.all([
    evil ? Promise.resolve(null) : until(async () => { const m = await media(grace); return m.openPcs === 0 && m.liveTracks === 0; }, selfBoundMs),
    until(async () => (await media(ada)).openPcs === 0, othersBoundMs),
  ]);
  const graceAfter = await media(grace).catch(() => null);
  const row = { name, evil, actMs, selfStoppedMs: evil ? "n/a (ignores stop)" : self, othersClosedMs: others, graceStill: graceAfter };
  const ok = (evil || self !== null) && others !== null;
  results.push({ ...row, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${evil ? " [adversarial]" : ""}: self ${row.selfStoppedMs === null ? "NOT stopped" : typeof row.selfStoppedMs === "number" ? `stopped in ${row.selfStoppedMs} ms` : row.selfStoppedMs}, others closed ${others === null ? "NOT within bound" : `in ${others} ms`} (after a ${actMs} ms action)${evil ? `; its own state: ${JSON.stringify(graceAfter)}` : ""}`);
  await ada.context().close();
  await grace.context().close();
}

const revokeAccess = async ({ ada }) => {
  await ada.getByRole("tab", { name: /People/ }).click();
  await ada.getByLabel("Who can join").selectOption("invited");
  await ada.getByLabel("Invited ids").fill("");
  await ada.getByRole("button", { name: "Save access" }).click();
};
const removeByHost = async ({ ada }) => {
  await ada.getByRole("tab", { name: /People/ }).click();
  await ada.locator(".people li", { hasText: "Grace" }).getByRole("button", { name: "Remove" }).click();
};
const signOutInAnotherTab = async ({ grace }) => {
  const tab = await grace.context().newPage();
  await tab.goto(URL_);
  await tab.getByLabel("Signed in as").selectOption(""); // the same browser: the session cookie is cleared
  await tab.close();
};
const sessionRevokedElsewhere = async ({ grace }) => {
  // Grace on another device revokes every other session of hers.
  const other = await person("grace");
  await other.evaluate(async () => {
    const h = { "Content-Type": "application/json", "X-FeltKit-Session": "cookie" };
    const s = await (await fetch("/api/session", { headers: h })).json();
    const r = await fetch("/api/auth/sessions/revoke", { method: "POST", headers: { ...h, "X-FeltKit-CSRF": s.csrf }, body: JSON.stringify({ all: true, keepCurrent: true }) });
    if (!r.ok) throw new Error(`revoke ${r.status} ${await r.text()}`);
  });
  await other.context().close();
};

try {
  await measure("access revoked by the host", { act: revokeAccess, selfBoundMs: 10_000, othersBoundMs: 10_000 });
  await measure("access revoked by the host", { evil: true, act: revokeAccess, othersBoundMs: 10_000 });
  await measure("removed by the host", { act: removeByHost, selfBoundMs: 10_000, othersBoundMs: 10_000 });
  await measure("removed by the host", { evil: true, act: removeByHost, othersBoundMs: 10_000 });
  await measure("signed out in another tab of the same browser", { act: signOutInAnotherTab, selfBoundMs: 20_000, othersBoundMs: 75_000 });
  await measure("session revoked from another device", { act: sessionRevokedElsewhere, selfBoundMs: 20_000, othersBoundMs: 75_000 });
  await measure("session revoked from another device", { evil: true, act: sessionRevokedElsewhere, othersBoundMs: 75_000 });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} termination cases within bounds`);
process.exit(failed.length ? 1 : 0);
