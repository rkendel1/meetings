// Session expiry and cleanup, against `npm run dev`: an agent attends a live call with a session that
// expires after 36 s (feltkit session create --ttl 0.01) and keeps checking in every 10 s. Needs FeltKit
// with auth.onSessionEnd (expired sessions ended within 5 s); without it, the 8 s bound fails.
// Measures: when its calls are refused, when the person in the call stops seeing it, and what the durable
// record says (attendance: it left at its last successful check-in, not when someone noticed).
//   node scripts/e2e-session-expiry.mjs [url]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");

const URL_ = process.argv[2] ?? "http://localhost:3000";
const session = JSON.parse(execFileSync("npx", ["feltkit", "session", "create", "--type", "agent", "--id", "short-lived", "--role", "agent", "--name", "Short-lived agent", "--ttl", "0.01", "--json"], { encoding: "utf8" }));
const expiresAt = Date.parse(session.expiresAt);

async function mcp(name, args) {
  const res = await fetch(`${URL_}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.status === 200 && body?.result && !body.result.isError, body };
}

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
try {
  const page = await (await browser.newContext({ permissions: ["camera", "microphone"] })).newPage();
  await page.goto(URL_);
  await page.getByLabel("Signed in as").selectOption("ada");
  await page.getByText("Your meetings").waitFor();
  await page.waitForFunction(async () => (await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json()).principal?.id === "ada", null, { polling: 250 });
  await page.getByRole("button", { name: "Start a meeting now" }).click();
  await page.waitForURL(/\/m\//);
  const code = page.url().split("/m/")[1];
  await page.getByRole("button", { name: "Start the call" }).click();
  await page.locator(".room").waitFor();
  await page.getByRole("tab", { name: /^People/ }).click(); // agents attend only with the host's approval
  await page.getByLabel("Agents").selectOption("open");
  await page.getByRole("button", { name: "Save access" }).click();
  await page.getByRole("button", { name: "Saved" }).waitFor();

  let lastOk = 0;
  let refusedAt = null;
  let refusal = null;
  const t0 = Date.now();
  assert.ok((await mcp("meetings_join", { code })).ok, "the agent joins");
  lastOk = Date.now();
  await page.locator('.tile[data-peer="short-lived"]').waitFor();
  while (Date.now() - t0 < 90_000 && refusedAt === null) {
    await new Promise((r) => setTimeout(r, 10_000));
    const r = await mcp("meetings_join", { code });
    if (r.ok) lastOk = Date.now();
    else {
      refusedAt = Date.now();
      refusal = { status: r.status, error: r.body?.error?.message ?? JSON.stringify(r.body).slice(0, 120) };
    }
  }
  assert.ok(refusedAt, "the expired session is refused");
  const goneWithin = await page.waitForFunction(() => !document.querySelector('.tile[data-peer="short-lived"]'), null, { timeout: 90_000, polling: 500 }).then(() => Date.now());
  // Cleanup is durable: the recap records when the agent left. Host reads it after ending the call.
  await page.getByRole("button", { name: "Leave call" }).click();
  await page.getByRole("button", { name: "See the recap" }).click();
  await page.getByText("Attendance").waitFor();
  const row = await page.locator(".attendance tbody tr", { hasText: "Short-lived agent" }).innerText();
  console.log(JSON.stringify({
    sessionExpiresInMs: expiresAt - t0,
    refusedAfterExpiryMs: refusedAt - expiresAt,
    refusal,
    lastSuccessfulCheckInBeforeExpiryMs: expiresAt - lastOk,
    tileGoneAfterLastCheckInMs: goneWithin - lastOk,
    tileGoneAfterExpiryMs: goneWithin - expiresAt,
    recapRow: row.replace(/\s+/g, " "),
  }, null, 1));
  assert.ok(refusedAt >= expiresAt - 1000, "not refused before it expired");
  // FeltKit ends an expired session within its sweep (5 s) and runs auth.onSessionEnd: the agent is gone for
  // everyone within that, not when its presence would have expired (45 s after its last check-in).
  assert.ok(goneWithin - expiresAt <= 8_000, `gone ${goneWithin - expiresAt} ms after the session expired (bound 8 s)`);
  console.log("✓ session expiry: refused after expiry, presence expired, attendance recorded");
} finally {
  await browser.close();
}
