// End-to-end check against a running `npm run dev`: two people in separate browser contexts
// (fake camera and microphone) connect media peer-to-peer, and an agent attends over MCP.
// Usage: AGENT_TOKEN=<token from `npx feltkit session create --type agent --id claude --role agent`> node scripts/e2e.mjs [url]
import { createRequire } from "node:module";
// The preinstalled Playwright (or add it: npm i -D playwright).
const { chromium } = createRequire(import.meta.url)("playwright");
import assert from "node:assert/strict";

const URL_ = process.argv[2] ?? "http://localhost:3000";
const TOKEN = process.env.AGENT_TOKEN;
const SHOTS = process.env.SHOTS_DIR;
if (!TOKEN) throw new Error("Set AGENT_TOKEN to an agent session token.");

let rpcId = 0;
async function mcp(name, args) {
  const res = await fetch(`${URL_}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const result = body.result;
  if (!result || result.isError) throw new Error(`${name} failed: ${JSON.stringify(body).slice(0, 400)}`);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen", "--auto-accept-this-tab-capture"] });
const person = async (user) => {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${user}] pageerror`, e.message));
  await page.goto(URL_);
  await page.getByLabel("Signed in as").waitFor();
  await page.getByLabel("Signed in as").selectOption(user);
  await page.getByText("Your meetings").waitFor();
  return page;
};

try {
  const ada = await person("ada");
  const grace = await person("grace");

  await ada.getByRole("button", { name: "Start a meeting now" }).click();
  await ada.waitForURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  const code = ada.url().split("/m/")[1];
  await ada.getByRole("button", { name: "Start the call" }).click();
  await ada.locator('.tile[data-peer="ada"]').waitFor();
  console.log("ada started call", code);

  await grace.goto(`${URL_}/m/${code}`);
  await grace.getByText("Ada Lovelace is in the call").waitFor();
  await grace.getByRole("button", { name: "Join now" }).click();

  // Media: each sees the other's tile connected, with live video frames.
  for (const [page, other] of [[ada, "grace"], [grace, "ada"]]) {
    const tile = page.locator(`.tile[data-peer="${other}"]`);
    await tile.waitFor();
    await page.waitForFunction((o) => document.querySelector(`.tile[data-peer="${o}"]`)?.getAttribute("data-state") === "connected", other, { timeout: 20000 });
    await page.waitForFunction((o) => (document.querySelector(`.tile[data-peer="${o}"] video`)?.videoWidth ?? 0) > 0, other, { timeout: 15000 }).catch(async (e) => {
      console.error(other, await page.evaluate((o) => { const v = document.querySelector(`.tile[data-peer="${o}"] video`); const s = v?.srcObject; return { cls: v?.className, w: v?.videoWidth, rs: v?.readyState, paused: v?.paused, tracks: s?.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted}`) }; }, other));
      throw e;
    });
  }
  console.log("✓ media connected both ways (remote video frames decoded)");

  // The agent attends over MCP.
  const meetings = await mcp("meetings_get", { code });
  assert.equal(meetings.peers.filter((p) => p.kind === "person").length, 2);
  const joined = await mcp("meetings_join", { code });
  await ada.locator('.tile[data-peer="claude"] .agent-badge').waitFor();
  console.log("✓ agent joined via MCP and appears as an AI agent tile", joined.peerId);

  await grace.getByLabel("Message").fill("Claude, please note: launch moves to Friday.");
  await grace.getByRole("button", { name: "Send" }).click();
  let feed = { entries: [], next: 0 };
  for (let i = 0; i < 20 && !feed.entries.some((e) => e.kind === "chat"); i++) {
    feed = await mcp("meetings_feed", { code, after: 0 });
    await new Promise((r) => setTimeout(r, 250));
  }
  const heard = feed.entries.find((e) => e.kind === "chat");
  assert.equal(heard.authorId, "grace");
  console.log("✓ agent read the timeline:", heard.text);

  await mcp("chat_send", { code, text: "Noted: launch moves to Friday." });
  await mcp("notes_add", { code, text: "Decision: launch moves to Friday. Owner: Grace." });
  await mcp("chat_react", { code, emoji: "👍" });
  await ada.locator(".message.agent", { hasText: "Noted: launch moves to Friday." }).waitFor();
  await ada.locator(".message.note", { hasText: "Decision: launch moves to Friday" }).waitFor();
  console.log("✓ agent's chat message and note appear live in the call");

  if (SHOTS) {
    await ada.waitForTimeout(400);
    await ada.screenshot({ path: `${SHOTS}/call.png` });
  }

  // Screen share swaps the outgoing track (no renegotiation); the other side switches to the stage layout.
  await ada.getByRole("button", { name: "Share screen" }).click();
  await grace.locator('.stage-main .tile[data-peer="ada"]').waitFor({ timeout: 10000 });
  await grace.waitForFunction(() => (document.querySelector('.stage-main .tile[data-peer="ada"] video')?.videoWidth ?? 0) > 0, null, { timeout: 10000 });
  console.log("✓ screen share: grace sees ada presenting on the stage");
  await ada.getByRole("button", { name: "Stop sharing" }).click();
  await grace.locator(".stage-main").waitFor({ state: "detached" });

  // Leaving: the agent alone does not keep the call open.
  await grace.getByRole("button", { name: "Leave call" }).click();
  await grace.getByText("You left the call").waitFor();
  await ada.getByRole("button", { name: "Leave call" }).click();
  await ada.getByText("You left the call").waitFor();
  const after = await mcp("meetings_get", { code });
  assert.equal(after.call, null);
  console.log("✓ call ended when the last person left, although the agent was attending");

  await ada.getByRole("button", { name: "See the recap" }).click();
  await ada.getByText("Attendance").waitFor();
  const rows = await ada.locator(".attendance tbody tr").allInnerTexts();
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => r.includes("Claude") && r.includes("AI agent")));
  await ada.locator(".note", { hasText: "Decision: launch moves to Friday" }).waitFor();
  console.log("✓ recap shows attendance (2 people + agent), the agent's note and the timeline");
  if (SHOTS) await ada.screenshot({ path: `${SHOTS}/recap.png`, fullPage: true });
  console.log("E2E PASSED");
} finally {
  await browser.close();
}
