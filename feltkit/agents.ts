/**
 * The application's own agents. Each is its own principal with its own role, runs after a commit (FeltKit's outbox:
 * at least once, with retries), and holds only what its role grants. They are the application's, not a model's:
 * the model is asked for by a person (feltkit/ai.ts), and what it returns is stored by that person's own authority.
 *
 *   scribe     when a call ends, writes its recap: attendance, what was marked "action:" / "decision:", the notes.
 *   assistant  speaks in the timeline for a person who asked it a question, so an answer is never attributed to them.
 */
import { s } from "@feltdb/feltkit";
import { app, calls, entries, meetings } from "./app.js";
import { peers } from "./_presence.js";
import { append, byCode, latestCall, type Call, type Meeting, type Peer } from "./_meeting.js";
import { addAction, addDecision, marker, parseAction, summaries, type Summary } from "./_records.js";

const SCRIBE = { id: "scribe", name: "Scribe", kind: "agent" as const };

export const scribe = app.agent("scribe", {
  principal: { id: "scribe", displayName: "Scribe" },
  roles: ["scribe"],
  access: "scribe.run",
  description: "Writes a call's recap when it ends: who attended, what was marked as an action or a decision, and the notes.",
  handler: async (ctx, input: { callId?: string }) => {
    const call = input.callId ? ((await ctx.db.get(calls, input.callId)) as Call | null) : null;
    if (!call || call.endedAt === undefined) return;
    const meeting = (await ctx.db.get(meetings, call.meetingId)) as Meeting | null;
    if (!meeting) return;
    // At least once: a repeated run finds its own summary and stops.
    if (((await ctx.db.find(summaries, { callId: call.id })) as Summary[]).some((x) => x.source === "scribe")) return;

    const timeline = (await ctx.db.find(entries, { callId: call.id }, { orderBy: [{ field: "seq", direction: "asc" }] })) as any[];
    let actions = 0;
    let made = 0;
    for (const e of timeline) {
      if (e.kind === "system" || e.kind === "reaction") continue;
      const m = marker(e.text);
      if (!m) continue;
      if (m.kind === "decision") made += Number((await addDecision(ctx, meeting, { callId: call.id, text: m.body, source: "scribe", sourceEntryId: e.id, by: SCRIBE })).created);
      else {
        const a = parseAction(m.body);
        const item = await addAction(ctx, meeting, { callId: call.id, text: a.text, ...(a.assignee ? { assignee: a.assignee } : {}), ...(a.dueAt ? { dueAt: a.dueAt } : {}), source: "scribe", sourceEntryId: e.id, by: SCRIBE }).catch((error: any) =>
          // "@someone" who is not in the meeting: keep the item, unassigned, rather than lose it.
          error?.code === "INVALID_ARGUMENT" ? addAction(ctx, meeting, { callId: call.id, text: m.body, source: "scribe", sourceEntryId: e.id, by: SCRIBE }) : Promise.reject(error),
        );
        actions += Number(item.created);
      }
    }

    const devices = (await ctx.db.find(peers, { callId: call.id })) as Peer[];
    const who = (kind: string) => new Set(devices.filter((p) => p.kind === kind).map((p) => p.principalId)).size;
    const minutes = Math.max(1, Math.round((call.endedAt - call.startedAt) / 60_000));
    const said = timeline.filter((e) => e.kind === "chat" || e.kind === "caption").length;
    const notes = timeline.filter((e) => e.kind === "note").map((e) => `• ${e.text}`);
    const text = [
      `Call ${call.number} of "${meeting.title}" ran ${minutes} min with ${who("person")} ${who("person") === 1 ? "person" : "people"}${who("agent") ? ` and ${who("agent")} agent${who("agent") === 1 ? "" : "s"}` : ""}.`,
      said ? `${said} chat and caption lines were recorded.` : "No chat or captions were recorded.",
      made || actions ? `Marked in the call: ${made} decision${made === 1 ? "" : "s"}, ${actions} action item${actions === 1 ? "" : "s"}.` : "",
      notes.length ? `Notes:\n${notes.slice(0, 8).join("\n")}` : "",
      "This is the scribe's outline. Ask for an AI recap in the recap page for a written summary.",
    ].filter(Boolean).join("\n");
    await ctx.db.insert(summaries, { meetingId: meeting.id, callId: call.id, text: text.slice(0, 8000), source: "scribe", authorId: SCRIBE.id, authorName: SCRIBE.name, createdAt: Date.now() });
    ctx.afterCommit.notifications.send({ recipient: meeting.hostId, type: "recap.ready", title: `Recap ready: ${meeting.title}`, data: { code: meeting.code, call: call.number }, idempotencyKey: `recap:${call.id}` });
  },
});

export const assistant = app.agent("assistant", {
  principal: { id: "assistant", displayName: "Assistant" },
  roles: ["assistant"],
  access: "assistant.run",
  description: "Answers a person's question in the meeting's timeline, attributed to the assistant.",
  handler: async (ctx, input: { code?: string; question?: string; answer?: string; askedBy?: string }) => {
    if (!input.code || !input.answer) return;
    const meeting = await byCode(ctx, input.code);
    if (!meeting) return;
    const call = await latestCall(ctx, meeting.id);
    // FeltKit commits an agent run's writes at most once per trigger, so a retry cannot post the answer twice.
    await append(ctx, meeting, { ...(call && call.endedAt === undefined ? { callId: call.id } : {}), kind: "chat", text: `${input.askedBy ? `${input.askedBy} asked: ${input.question}\n` : ""}${input.answer}`.slice(0, 3990), author: { id: "assistant", name: "Assistant", kind: "agent" } });
  },
});
