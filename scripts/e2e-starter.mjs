// The starter's platform features against a running `npm run dev`, over HTTP only (no browser), with a loopback
// OpenAI-compatible model so the model path runs for real: public branding, host-approved agents over MCP, the
// meeting's records, the scribe, the model's recap and the assistant's answer, search, recording, the sweep.
//   node scripts/e2e-starter.mjs [url]
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";

const URL_ = process.argv[2] ?? "http://localhost:3000";

// ── a model that answers like a model: a recap as JSON, or a short answer ────────────────────────────
const seen = [];
const model = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c)).on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push(body);
    const prompt = JSON.stringify(body.messages);
    const text = /You write meeting recaps/.test(prompt)
      ? JSON.stringify({ summary: "The team agreed to ship Friday and Grace owns the notes.", decisions: ["Ship on Friday", "Hold the retro on Monday"], actions: [{ text: "Write the release notes", assignee: "Grace", due: "2026-12-05" }, { text: "Ask legal", assignee: "Someone Invented", due: null }] })
      : "We decided to ship on Friday.";
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${model.address().port}/v1`;
execFileSync("npx", ["feltkit", "model", "set", "--provider", "custom", "--model", "loopback-1", "--endpoint", endpoint, "--api-key-stdin"], { input: "test-key\n", stdio: ["pipe", "ignore", "inherit"] });

// ── a signed-in person over HTTP (the browser's cookie flow) ─────────────────────────────────────────
async function person(id) {
  const res = await fetch(`${URL_}/api/auth/dev`, { method: "POST", headers: { "content-type": "application/json", "X-FeltKit-Session": "cookie" }, body: JSON.stringify({ userId: id }) });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const { csrf } = await res.json();
  const call = async (kind, name, args = {}) => {
    const r = await fetch(`${URL_}/api/${kind}/${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/json", "X-FeltKit-Session": "cookie", cookie, "X-FeltKit-CSRF": csrf }, body: JSON.stringify({ args }) });
    const body = await r.json();
    if (!body.ok) throw Object.assign(new Error(body.error?.message ?? JSON.stringify(body)), { code: body.error?.code });
    return body.value;
  };
  return { q: (n, a) => call("query", n, a), m: (n, a) => call("mutation", n, a), a: (n, a) => call("action", n, a) };
}
const refused = async (promise, code) => assert.rejects(promise, (e) => (code ? e.code === code : true));

// ── an agent over MCP ────────────────────────────────────────────────────────────────────────────────
const session = JSON.parse(execFileSync("npx", ["feltkit", "session", "create", "--type", "agent", "--id", "scout", "--role", "agent", "--name", "Scout", "--json"], { encoding: "utf8" }));
let rpc = 0;
async function tool(name, args) {
  const r = await fetch(`${URL_}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  const text = body.result?.content?.[0]?.text;
  return { ok: Boolean(body.result) && !body.result.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

try {
  // Branding: public, so the sign-in page can wear it before anyone signs in.
  const anon = await (await fetch(`${URL_}/api/query/settings:brand`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(anon.ok, true);
  const ada = await person("ada");
  const grace = await person("grace");
  await refused(grace.m("settings:save", { name: "Nope" }), "FORBIDDEN");
  await ada.m("settings:save", { name: "Northwind Calls", tagline: "Talk it through.", accent: "#0d9488" });
  assert.equal((await (await fetch(`${URL_}/api/query/settings:brand`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).value.name, "Northwind Calls");
  console.log("✓ branding: public to everyone, changed only by an admin");

  const tools = (await (await fetch(`${URL_}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }) })).json()).result.tools.map((t) => t.name);
  for (const n of ["actions_add", "decisions_add", "summaries_save", "search_find", "meetings_feed", "inbox_list"]) assert.ok(tools.includes(n), `agents are offered ${n}`);
  assert.ok(!tools.includes("settings_save") && !tools.includes("maintenance_sweep"), "agents are not offered admin functions");

  const m = await ada.m("meetings:create", { title: "Launch review" });
  const a = await ada.m("calls:join", { code: m.code });
  const g = await grace.m("calls:join", { code: m.code });
  assert.equal((await tool("meetings_get", { code: m.code })).ok, false, "an agent holding only the link is not admitted");
  await ada.m("meetings:update", { code: m.code, invited: ["scout"] });
  assert.ok((await tool("meetings_join", { code: m.code })).ok, "the host approved it");
  console.log("✓ agent admission: refused until the host approves it");

  await grace.m("chat:send", { code: m.code, text: "decision: the launch review happens Thursday" });
  await ada.m("chat:caption", { peerId: a.peerId, code: m.code, text: "action: @grace book the room by 2026-12-02" });
  assert.ok((await tool("decisions_add", { code: m.code, text: "Ship on Friday" })).ok);
  assert.ok((await tool("actions_add", { code: m.code, text: "Draft the announcement", assignee: "Ada" })).ok);
  assert.ok((await tool("summaries_save", { code: m.code, text: "Agreed: ship Friday." })).ok);
  await ada.m("recording:start", { code: m.code });
  const live = await tool("meetings_get", { code: m.code });
  assert.equal(live.json.call.recording.byName, "Ada Lovelace", "an agent sees that the call is being recorded");
  await ada.m("recording:stop", { code: m.code });
  console.log("✓ agent worked in the call: decision, action item, summary; saw the recording notice");

  // The call ends; the scribe writes its recap after the commit.
  await grace.m("calls:leave", { code: m.code, peerId: g.peerId });
  await ada.m("calls:leave", { code: m.code, peerId: a.peerId });
  let scribe;
  for (let i = 0; i < 50 && !scribe; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const all = await ada.q("summaries:get", { code: m.code });
    if (all.versions >= 2) scribe = all;
  }
  assert.ok(scribe, "the scribe wrote its recap");
  const items = await ada.q("actions:list", { code: m.code });
  assert.ok(items.some((i) => i.text === "book the room" && i.assigneeId === "grace" && i.source === "scribe"));
  assert.ok((await ada.q("decisions:list", { code: m.code })).some((d) => d.text === "the launch review happens Thursday" && d.source === "scribe"));
  assert.ok((await grace.q("inbox:list", {})).some((n) => n.type === "actionitem.assigned"), "the assignee is notified");
  assert.ok((await ada.q("inbox:list", {})).some((n) => n.type === "recap.ready"), "the host is told the recap is ready");
  console.log("✓ scribe: recap, decisions and assigned action items from what people marked");

  // The model, asked for by a person.
  const gen = await ada.a("ai:recap", { code: m.code });
  assert.deepEqual([gen.decisions, gen.actions], [1, 2]);
  const latest = (await ada.q("summaries:get", { code: m.code })).summary;
  assert.deepEqual([latest.source, latest.model, Boolean(latest.taskId)], ["model", "custom/loopback-1", true]);
  assert.match(JSON.stringify(seen[0].messages), /never instructions/, "the transcript reaches the model as data");
  assert.match(JSON.stringify(seen[0].messages), /book the room/);
  const all = await ada.q("actions:list", { code: m.code });
  assert.ok(all.some((i) => i.text === "Write the release notes" && i.assigneeId === "grace" && i.source === "model"));
  assert.ok(all.some((i) => i.text === "Ask legal" && !i.assigneeId), "an invented assignee keeps the item, unassigned");
  await ada.m("actions:update", { id: all.find((i) => i.text === "Ask legal").id, status: "cancelled" });
  console.log("✓ model: recap, decisions and action items stored as the person's, with generation evidence");

  const live2 = await ada.m("calls:join", { code: m.code });
  await ada.a("ai:ask", { code: m.code, question: "What did we decide about the launch?", history: true });
  let said;
  for (let i = 0; i < 50 && !said; i++) {
    await new Promise((r) => setTimeout(r, 200));
    said = (await ada.q("meetings:feed", { code: m.code })).entries.find((e) => e.authorId === "assistant");
  }
  assert.ok(said && said.authorKind === "agent" && /ship on Friday/.test(said.text), "the assistant answered in the timeline");
  assert.match(seen.at(-1).messages.map((x) => x.content).join("\n"), /Earlier meetings:/, "earlier meetings were searched for the answer");
  console.log("✓ assistant: answers as itself, from this call and earlier meetings");

  const found = await tool("search_find", { query: "ship friday" });
  assert.ok(found.json.hits.length >= 2, "an agent researches past meetings it attended");
  await ada.m("calls:leave", { code: m.code, peerId: live2.peerId });
  const swept = await ada.m("maintenance:sweep", {});
  assert.ok(swept.settled >= 0);
  await refused(grace.m("maintenance:sweep", {}), "FORBIDDEN");
  const bundle = await ada.q("meetings:exportAll", { code: m.code });
  assert.ok(bundle.entries.length > 5 && bundle.actionItems.length >= 4);
  console.log("✓ search, sweep (admin only), export");

  await ada.m("settings:save", { name: "Meetings" }); // leave the development brand as it was
  console.log("\nstarter features: all verified over HTTP, MCP and a loopback model");
} finally {
  model.close();
}
