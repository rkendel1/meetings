// End-to-end and failure-condition checks against a running `npm run dev` (development dev users).
//
//   node scripts/e2e.mjs [url]                 # creates its own agent sessions with `npx feltkit session create`
//   SHOTS_DIR=/tmp/shots node scripts/e2e.mjs   # also saves screenshots
//   SKIP_SLOW=1 node scripts/e2e.mjs            # skips the scenarios that wait for presence expiry (~2 min)
//
// What this proves: the app's lifecycle, signaling and authorization behave correctly in real browsers on
// one machine. What it cannot prove: media across real networks (NAT, firewalls, TURN). Browsers here
// share a host, so ICE always finds a direct path.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// The preinstalled Playwright (or add it: npm i -D playwright).
const { chromium } = createRequire(import.meta.url)("playwright");

const URL_ = process.argv[2] ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS_DIR;
const SLOW = !process.env.SKIP_SLOW;

function feltkit(...args) {
  return execFileSync("npx", ["feltkit", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function agentSession(id, name) {
  return JSON.parse(feltkit("session", "create", "--type", "agent", "--id", id, "--role", "agent", "--name", name, "--json")).token;
}

let rpcId = 0;
async function mcpRaw(token, method, params, meta) {
  const res = await fetch(`${URL_}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: meta ? { ...params, _meta: meta } : params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function mcp(token, name, args, meta) {
  const { status, body } = await mcpRaw(token, "tools/call", { name, arguments: args }, meta);
  const result = body?.result;
  if (status !== 200 || !result || result.isError) {
    const err = new Error(`${name} failed (${status}): ${JSON.stringify(body?.error ?? result?.content ?? body).slice(0, 300)}`);
    err.status = status;
    throw err;
  }
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

const results = [];
async function scenario(name, run) {
  const start = Date.now();
  try {
    await run();
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`✓ ${name} (${((Date.now() - start) / 1000).toFixed(1)} s)`);
  } catch (error) {
    results.push({ name, ok: false, known: Boolean(error.known), ms: Date.now() - start, error: error.message });
    console.log(`${error.known ? "⚠ (known platform gap)" : "✗"} ${name}: ${error.message.split("\n")[0]}`);
  }
}

const media = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"];
const browser = await chromium.launch({ args: media });
const noMediaBrowser = await chromium.launch({ args: [] }); // no fake devices, no auto-accept: permission is denied
const contexts = [];

async function person(user, { b = browser, permissions = ["camera", "microphone"] } = {}) {
  const ctx = await b.newContext({ permissions, viewport: { width: 1280, height: 800 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`  [${user}] pageerror`, e.message));
  await page.goto(URL_);
  await page.getByLabel("Signed in as").waitFor();
  await page.getByLabel("Signed in as").selectOption(user);
  await page.getByText("Your meetings").waitFor();
  return page;
}
const tile = (page, who) => page.locator(`.tile[data-peer="${who}"]`);
async function connected(page, other, timeout = 25000) {
  await page.waitForFunction((o) => {
    const t = document.querySelectorAll(`.tile[data-peer="${o}"]`);
    return t.length === 1 && t[0].getAttribute("data-state") === "connected";
  }, other, { timeout });
}
async function seesVideo(page, other, timeout = 15000) {
  await page.waitForFunction((o) => (document.querySelector(`.tile[data-peer="${o}"] video`)?.videoWidth ?? 0) > 0, other, { timeout });
}
async function joinCall(page, code) {
  await page.goto(`${URL_}/m/${code}`);
  await page.getByRole("button", { name: /Join now|Start the call/ }).click();
  await page.locator(".room").waitFor();
}
async function say(page, text) {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const claude = agentSession("claude", "Claude");
let code;
let ada, grace, alan;

try {
  await scenario("two people connect media both ways; screen share reaches the other side", async () => {
    ada = await person("ada");
    grace = await person("grace");
    await ada.getByRole("button", { name: "Start a meeting now" }).click();
    await ada.waitForURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    code = ada.url().split("/m/")[1];
    await ada.getByRole("button", { name: "Start the call" }).click();
    // Agents attend only with the host's approval; this run's agent has none, so the host opens the meeting to agents.
    await ada.getByRole("tab", { name: /^People/ }).click();
    await ada.getByLabel("Agents").selectOption("open");
    await ada.getByRole("button", { name: "Save access" }).click();
    await ada.getByRole("button", { name: "Saved" }).waitFor();
    await ada.getByRole("tab", { name: "Chat" }).click();
    await joinCall(grace, code);
    await connected(ada, "grace");
    await connected(grace, "ada");
    await seesVideo(ada, "grace");
    await seesVideo(grace, "ada");
    await ada.getByRole("button", { name: "Share screen" }).click();
    await grace.locator('.stage-main .tile[data-peer="ada"]').waitFor({ timeout: 10000 });
    await grace.waitForFunction(() => (document.querySelector('.stage-main .tile[data-peer="ada"] video')?.videoWidth ?? 0) > 0, null, { timeout: 10000 });
    await ada.getByRole("button", { name: "Stop sharing" }).click();
    await grace.locator(".stage-main").waitFor({ state: "detached" });
  });

  await scenario("an agent must join before it can read a running call; then it participates over MCP", async () => {
    await assert.rejects(mcp(claude, "meetings_feed", { code }), /Join the call|FORBIDDEN/);
    await assert.rejects(mcp(claude, "chat_send", { code, text: "lurking" }), /Join the call|FORBIDDEN/);
    await mcp(claude, "meetings_join", { code });
    await tile(ada, "claude").locator(".agent-badge").waitFor();
    await say(grace, "Claude, please note: launch moves to Friday.");
    let feed = { entries: [] };
    for (let i = 0; i < 20 && !feed.entries.some((e) => e.kind === "chat"); i++) {
      feed = await mcp(claude, "meetings_feed", { code, after: 0 });
      await sleep(250);
    }
    assert.equal(feed.entries.find((e) => e.kind === "chat").authorId, "grace");
    await mcp(claude, "chat_send", { code, text: "Noted: launch moves to Friday." });
    await mcp(claude, "notes_add", { code, text: "Decision: launch moves to Friday. Owner: Grace." });
    await ada.locator(".message.agent", { hasText: "Noted: launch moves to Friday." }).waitFor();
    await ada.locator(".message.note", { hasText: "Decision: launch moves to Friday" }).waitFor();
    if (SHOTS) await ada.screenshot({ path: `${SHOTS}/call.png` });
  });

  await scenario("AppPort HTTP: a replayed call with the same idempotency key runs once; the same key with a new body is refused", async () => {
    const h = { "content-type": "application/json", authorization: `Bearer ${claude}` };
    const call = async (input, key) => {
      const r = await fetch(`${URL_}/appport`, { method: "POST", headers: h, body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: crypto.randomUUID(), capability: { name: "chat.send", version: 1 }, input, idempotencyKey: key }) });
      return { status: r.status, body: await r.json() };
    };
    const key = `e2e-http-${Date.now()}`;
    const first = await call({ code, text: "exactly once (http)" }, key);
    const replay = await call({ code, text: "exactly once (http)" }, key);
    assert.equal(first.status, 200);
    assert.equal(replay.body.output.id, first.body.output.id);
    const reused = await call({ code, text: "another body" }, key);
    assert.equal(reused.body.error?.details?.reason ?? reused.body.error?.code, "IDEMPOTENCY_KEY_REUSED");
  });

  // Published FeltKit 0.3.32 drops params._meta on /mcp (fixed on rkendel1/feltkit, test/mcp-idempotency.test.ts):
  // there this is reported as a known platform gap; with the fix it passes.
  await scenario("MCP: a replayed tools/call with the same idempotency key runs once", async () => {
    const key = { "dev.appport/idempotencyKey": `e2e-mcp-${Date.now()}` };
    const first = await mcp(claude, "chat_send", { code, text: "exactly once (mcp)" }, key);
    const replay = await mcp(claude, "chat_send", { code, text: "exactly once (mcp)" }, key);
    if (replay.id !== first.id) throw Object.assign(new Error("MCP replay ran twice: _meta idempotency key not forwarded (FeltKit ≤ 0.3.32)"), { known: true });
  });

  await scenario("agents cannot reach host or person operations over MCP; there is no tool for them", async () => {
    const { body } = await mcpRaw(claude, "tools/list", {});
    const tools = body.result.tools.map((t) => t.name);
    for (const forbidden of ["calls_end", "calls_heartbeat", "chat_caption", "signals_send", "signals_inbox", "meetings_update", "meetings_create"]) assert.ok(!tools.includes(forbidden), `${forbidden} is exposed`);
    // Not through the HTTP function API either: the server refuses by role, whatever the client.
    for (const [kind, path, args] of [["mutation", "calls:end", { code }], ["mutation", "meetings:update", { code, access: "link" }], ["query", "signals:inbox", { peerId: "x" }], ["mutation", "chat:caption", { code, peerId: "x", text: "x" }]]) {
      const res = await fetch(`${URL_}/api/${kind}/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${claude}` }, body: JSON.stringify({ args }) });
      assert.equal(res.status, 403, `${path} over HTTP answered ${res.status}`);
    }
  });

  await scenario("a revoked agent session is refused at once", async () => {
    const token = agentSession("intruder", "Intruder");
    await mcp(token, "meetings_list", {});
    const listing = feltkit("session", "list");
    const ref = listing.split("\n").find((l) => l.includes("intruder"))?.match(/\b(ses_[\w-]+|[a-f0-9]{8,})\b/)?.[1];
    assert.ok(ref, `no ref for the intruder session in:\n${listing}`);
    feltkit("session", "revoke", ref);
    const err = await mcp(token, "meetings_list", {}).catch((e) => e);
    assert.ok(err instanceof Error && (err.status === 401 || /UNAUTHORIZED|session/i.test(err.message)), `revoked token still works: ${err}`);
  });

  await scenario("a third person joins while another reloads: one tile each, all pairs connected, same call", async () => {
    alan = await person("alan");
    const before = await mcp(claude, "meetings_get", { code });
    await Promise.all([grace.reload(), joinCall(alan, code)]);
    await grace.locator(".room").waitFor({ timeout: 20000 }); // the reload rejoins without the lobby
    for (const [p, others] of [[ada, ["grace", "alan"]], [grace, ["ada", "alan"]], [alan, ["ada", "grace"]]]) {
      for (const o of others) await connected(p, o);
    }
    const after = await mcp(claude, "meetings_get", { code });
    assert.equal(after.call.id, before.call.id, "the reload continued the same call");
    assert.equal(after.peers.filter((p) => p.principalId === "grace").length, 1, "no ghost connection after the reload");
  });

  await scenario("a short network drop: heartbeats and live queries recover, chat flows both ways", async () => {
    await grace.context().setOffline(true);
    await sleep(8000);
    await grace.context().setOffline(false);
    await say(grace, "back online");
    await ada.locator(".message", { hasText: "back online" }).waitFor({ timeout: 20000 });
    await say(ada, "welcome back");
    await grace.locator(".message", { hasText: "welcome back" }).waitFor({ timeout: 20000 });
    const state = await mcp(claude, "meetings_get", { code });
    assert.equal(state.peers.filter((p) => p.principalId === "grace").length, 1);
  });

  await scenario("a lost camera turns the camera off for everyone instead of freezing", async () => {
    await ada.evaluate(() => {
      const v = document.querySelector('.tile[data-peer="ada"] video');
      v.srcObject.getVideoTracks()[0].dispatchEvent(new Event("ended"));
    });
    await ada.getByText("Your camera disconnected.").waitFor();
    await tile(grace, "ada").locator(".avatar").waitFor({ timeout: 20000 });
  });

  await scenario("camera and microphone denied: the person joins without media and still receives others", async () => {
    const p = await person("ada", { b: noMediaBrowser, permissions: [] });
    await p.goto(`${URL_}/m/${code}`);
    await p.getByText(/No camera or microphone/).waitFor({ timeout: 15000 });
    await p.getByRole("button", { name: "Join now" }).click();
    // Ada's second device: it does not connect media to her first tab (no feedback), but does to Grace.
    await connected(p, "grace");
    await seesVideo(p, "grace");
    assert.equal(await p.locator('.tile[data-peer="ada"]').count(), 2); // her own two connections are listed
    await p.getByRole("button", { name: "Leave call" }).click();
    await p.context().close();
  });

  await scenario("revoking access ejects a person from the live call", async () => {
    await ada.getByRole("tab", { name: /People/ }).click();
    await ada.getByLabel("Who can join").selectOption("invited");
    await ada.getByLabel("Invited ids").fill("grace, claude");
    await ada.getByRole("button", { name: "Save access" }).click();
    await alan.getByText(/removed from this call/).waitFor({ timeout: 20000 });
    await ada.waitForFunction(() => !document.querySelector('.tile[data-peer="alan"]'), null, { timeout: 20000 });
  });

  if (SLOW) {
    await scenario("offline past the presence timeout: the connection expires, then rejoins by itself", async () => {
      await grace.context().setOffline(true);
      await ada.waitForFunction(() => !document.querySelector('.tile[data-peer="grace"]'), null, { timeout: 90000 });
      await grace.context().setOffline(false);
      await connected(ada, "grace", 60000);
      await connected(grace, "ada", 30000);
      const state = await mcp(claude, "meetings_get", { code });
      assert.equal(state.peers.filter((p) => p.principalId === "grace").length, 1);
    });

    await scenario("the host's browser dies: the call goes on without them", async () => {
      await mcp(claude, "meetings_join", { code });
      await ada.context().setOffline(true);
      await ada.context().close();
      await grace.waitForFunction(() => !document.querySelector('.tile[data-peer="ada"]'), null, { timeout: 90000 });
      await say(grace, "still here");
      const state = await mcp(claude, "meetings_join", { code }).then(() => mcp(claude, "meetings_get", { code }));
      assert.ok(state.call);
      assert.deepEqual(state.peers.filter((p) => p.kind === "person").map((p) => p.principalId), ["grace"]);
    });
  }

  await scenario("the last person pressing Leave ends the call although an agent attends; the recap is complete", async () => {
    await mcp(claude, "meetings_join", { code });
    // Everyone still in the call leaves (Ada too, when the slow scenarios did not already crash her browser).
    if (!ada.isClosed()) {
      await ada.getByRole("button", { name: "Leave call" }).click();
      await ada.getByText("You left the call").waitFor();
    }
    await grace.getByRole("button", { name: "Leave call" }).click();
    await grace.getByText("You left the call").waitFor();
    const after = await mcp(claude, "meetings_get", { code });
    assert.equal(after.call, null);
    await grace.getByRole("button", { name: "See the recap" }).click();
    await grace.getByText("Attendance").waitFor();
    const rows = await grace.locator(".attendance tbody tr").allInnerTexts();
    assert.ok(rows.some((r) => r.includes("Claude") && r.includes("AI agent")));
    await grace.locator(".note", { hasText: "Decision: launch moves to Friday" }).waitFor();
    if (SHOTS) await grace.screenshot({ path: `${SHOTS}/recap.png`, fullPage: true });
  });
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
  await noMediaBrowser.close();
}

const failed = results.filter((r) => !r.ok && !r.known);
const known = results.filter((r) => !r.ok && r.known);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} scenarios passed, ${known.length} known platform gap(s), ${failed.length} failure(s)${SLOW ? "" : " (slow scenarios skipped)"}`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}\n    ${f.error}`);
  process.exit(1);
}
