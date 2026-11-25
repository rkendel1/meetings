// A real Add Eve run against running Meetings and Eve applications (development): no stubs. Prints what happened.
import { createClient } from "@feltdb/feltkit/client";
const url = process.env.MEETINGS_URL ?? "http://localhost:3400";
const as = async (who) => { const c = createClient({ url, session: "bearer" }); await c.signInAsDevUser(who); return c; };
const ada = await as("ada");
const grace = await as("grace");
const fn = (name) => ({ name });
await ada.mutation(fn("orgagents:register"), { principalId: "eve", name: "Eve", purpose: "Engineering teammate: remembers what we decided, looks at what we share, helps get it done.", operatedBy: "Acme platform team", connector: "eve", connectorGrant: process.env.EVE_CONNECTOR_GRANT });

// Last week's meeting: a person's decision and an open action item, from what was said.
const before = await ada.mutation(fn("meetings:create"), { title: "Billing sync (last week)", access: "invited", invited: ["grace", "eve"] });
const a1 = await ada.mutation(fn("calls:join"), { code: before.code });
await grace.mutation(fn("calls:join"), { code: before.code });
await ada.mutation(fn("chat:caption"), { peerId: a1.peerId, code: before.code, text: "The invoice total is off by a cent when a discount applies. Let's fix the rounding before the release." });
await ada.mutation(fn("decisions:add"), { code: before.code, text: "Fix invoice total rounding before the 2.0 release." });
await ada.mutation(fn("actions:add"), { code: before.code, text: "Reproduce the invoice rounding bug and find where totals are rounded", assignee: "grace" });
await grace.mutation(fn("calls:leave"), { code: before.code });
await ada.mutation(fn("calls:leave"), { code: before.code });

// Today: continues it. Ada starts the call and adds Eve.
const now = await ada.mutation(fn("meetings:create"), { title: "Billing sync", access: "invited", invited: ["grace"] });
await ada.mutation(fn("continuity:follows"), { code: now.code, previousCode: before.code });
const a2 = await ada.mutation(fn("calls:join"), { code: now.code });
const added = await ada.action(fn("orgagents:add"), { code: now.code, principalId: "eve" });
console.log("ADD EVE", JSON.stringify(added));
console.log("MEETING", now.code);
const beat = setInterval(() => ada.mutation(fn("calls:heartbeat"), { peerId: a2.peerId }).catch(() => {}), 15000);
const wait = async (pred, ms) => { const end = Date.now() + ms; let after = 0; const seen = []; while (Date.now() < end) { const f = await ada.query(fn("meetings:feed"), { code: now.code, after }); after = f.next; for (const e of f.entries) { seen.push(e); console.log(`  [${e.kind}] ${e.authorName}${e.authorKind === "agent" ? " (agent)" : ""}: ${e.text.slice(0, 600)}`); } const hit = seen.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 2000)); } return null; };
const joined = await wait((e) => e.authorId === "eve" && e.kind === "chat", 150000);
console.log("EVE JOINED", Boolean(joined));
await ada.mutation(fn("chat:send"), { code: now.code, text: "Eve, what did we decide in the previous meeting, and what is still open?" });
const answer = await wait((e) => e.authorId === "eve" && e.kind === "chat", 240000);
console.log("EVE ANSWERED", Boolean(answer));
clearInterval(beat);
process.exit(0);
