/**
 * What a meeting leaves behind besides its timeline: action items (assigned, with a status), decisions and
 * summaries. People, the scribe, the model and outside agents all write the same records through the same
 * functions, so each is checked, attributed and shown the same way. Not loaded as functions (leading underscore).
 */
import { fail, s } from "@feltdb/feltkit";
import { app, calls, entries, meetings } from "./app.js";
import { peers } from "./_presence.js";
import { signals } from "./signals.js";
import { kindOf, mayReadCall, nameOf, type Call, type Meeting, type Peer } from "./_meeting.js";

const Source = s.enum(["person", "agent", "scribe", "model"] as const);

export const actionItems = app.collection(
  "actionItems",
  {
    meetingId: s.ref("meetings"),
    callId: s.optional(s.string()),
    text: s.string({ minLength: 1, maxLength: 500 }),
    assigneeId: s.optional(s.string()),
    assigneeName: s.optional(s.string()),
    dueAt: s.optional(s.number()),
    status: s.enum(["open", "done", "cancelled"] as const),
    source: Source,
    // The timeline entry the item came from (when a line was marked "action: …"), so the same line never makes two items.
    sourceEntryId: s.optional(s.string()),
    createdById: s.string(),
    createdByName: s.string(),
    createdAt: s.number(),
    completedAt: s.optional(s.number()),
    remindedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["meetingId"] }, { fields: ["assigneeId"] }, { fields: ["status"] }] },
);

export const decisions = app.collection(
  "decisions",
  {
    meetingId: s.ref("meetings"),
    callId: s.optional(s.string()),
    text: s.string({ minLength: 1, maxLength: 500 }),
    source: Source,
    sourceEntryId: s.optional(s.string()),
    madeById: s.string(),
    madeByName: s.string(),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["meetingId"] }] },
);

/** A call's summary. A new one never replaces an old one: the latest is shown, the rest is history. */
export const summaries = app.collection(
  "summaries",
  {
    meetingId: s.ref("meetings"),
    callId: s.string(),
    text: s.string({ minLength: 1, maxLength: 8000 }),
    source: Source,
    // For a model's summary: "provider/model" and the FeltKit agent task holding the generation's evidence.
    model: s.optional(s.string({ maxLength: 120 })),
    taskId: s.optional(s.string({ maxLength: 64 })),
    authorId: s.string(),
    authorName: s.string(),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["meetingId"] }, { fields: ["callId"] }] },
);

export type ActionItem = { id: string; meetingId: string; callId?: string; text: string; assigneeId?: string; assigneeName?: string; dueAt?: number; status: "open" | "done" | "cancelled"; source: "person" | "agent" | "scribe" | "model"; sourceEntryId?: string; createdById: string; createdByName: string; createdAt: number; completedAt?: number; remindedAt?: number };
export type Decision = { id: string; meetingId: string; callId?: string; text: string; source: ActionItem["source"]; sourceEntryId?: string; madeById: string; madeByName: string; createdAt: number };
export type Summary = { id: string; meetingId: string; callId: string; text: string; source: ActionItem["source"]; model?: string; taskId?: string; authorId: string; authorName: string; createdAt: number };

type Principal = { id: string; type: string; displayName?: string };

/** Who the caller is, as records attribute them. */
export function actor(ctx: any): { id: string; name: string; kind: "person" | "agent"; source: "person" | "agent" } {
  const me = ctx.auth.requirePrincipal() as Principal;
  const kind = kindOf(me);
  return { id: me.id, name: nameOf(me), kind, source: kind };
}

/** The call a record belongs to: the numbered one, or the latest. */
export async function callOf(ctx: any, meeting: Meeting, callNumber?: number): Promise<Call | null> {
  const all = (await ctx.db.find(calls, { meetingId: meeting.id }, { orderBy: [{ field: "number", direction: "desc" }] })) as Call[];
  if (callNumber) {
    const call = all.find((c) => c.number === callNumber);
    if (!call) fail("NOT_FOUND", `This meeting has no call ${callNumber}.`);
    return call;
  }
  return all[0] ?? null;
}

/** Whether the principal is the host, an invitee, or was in any call of the meeting. */
export async function tookPart(ctx: any, meeting: Meeting, principalId: string): Promise<boolean> {
  if (meeting.hostId === principalId || meeting.invited.includes(principalId)) return true;
  return ((await ctx.db.find(peers, { principalId })) as Peer[]).some((p) => p.meetingId === meeting.id);
}

/**
 * May the caller read this meeting's records? The host, invitees and attendees: and while a call runs, only those
 * visibly in it (the same rule as the timeline, so a record never leaks what the call still keeps from outsiders).
 */
export async function mayReadRecords(ctx: any, meeting: Meeting, callId: string | undefined, principalId: string, now = Date.now()): Promise<boolean> {
  if (callId) {
    const call = (await ctx.db.get(calls, callId)) as Call | null;
    return call ? mayReadCall(ctx, meeting, call, principalId, now) : false;
  }
  return tookPart(ctx, meeting, principalId);
}

/** Who a person or agent in this meeting is: the host, invitees (by id) and everyone who attended (by id or name). */
export async function participants(ctx: any, meeting: Meeting): Promise<Array<{ id: string; name: string }>> {
  const seen = new Map<string, string>([[meeting.hostId, meeting.hostName]]);
  for (const id of meeting.invited) if (!seen.has(id)) seen.set(id, id);
  for (const p of (await ctx.db.find(peers, { meetingId: meeting.id })) as Peer[]) seen.set(p.principalId, p.name);
  return [...seen].map(([id, name]) => ({ id, name }));
}

/** An assignee named by id, by full name, or by first name when that is unambiguous. */
export function resolveAssignee(people: Array<{ id: string; name: string }>, ref: string): { id: string; name: string } | null {
  const needle = ref.trim().replace(/^@/, "").toLowerCase();
  if (!needle) return null;
  const exact = people.find((p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle);
  if (exact) return exact;
  const first = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === needle);
  return first.length === 1 ? first[0]! : null;
}

/**
 * Lines people (or the speech recogniser) mark for the record: "action: @ada send the budget by 2026-12-01",
 * "decision: ship on Friday", or spoken "action item send the budget". Anything else is not a record.
 */
export function marker(text: string): { kind: "action" | "decision"; body: string } | null {
  const m = text.trim().match(/^(?:(action item|action|todo|task|decision)\s*[:\-–]\s*|(action item|decision)\s+)(\S.*)$/i);
  if (!m) return null;
  const word = (m[1] ?? m[2])!.toLowerCase();
  return { kind: word === "decision" ? "decision" : "action", body: m[3]!.trim().slice(0, 500) };
}

/** "@ada send the budget by 2026-12-01" → assignee reference, task, due date. */
export function parseAction(body: string): { assignee?: string; text: string; dueAt?: number } {
  let text = body;
  let assignee: string | undefined;
  const at = text.match(/^@([\w.-]+)\s+(.+)$/);
  if (at) (assignee = at[1]), (text = at[2]!);
  let dueAt: number | undefined;
  const due = text.match(/\s+by\s+(\d{4}-\d{2}-\d{2})\s*$/i);
  if (due) {
    const when = Date.parse(`${due[1]}T17:00:00Z`);
    if (Number.isFinite(when)) (dueAt = when), (text = text.slice(0, due.index));
  }
  return { ...(assignee ? { assignee } : {}), text: text.trim() || body, ...(dueAt ? { dueAt } : {}) };
}

/**
 * Add an action item (deduplicated by its source line), and tell the assignee. The one place items are made:
 * people, agents, the scribe and the model all come through here.
 */
export async function addAction(
  ctx: any,
  meeting: Meeting,
  input: { callId?: string; text: string; assignee?: string; dueAt?: number; source: ActionItem["source"]; sourceEntryId?: string; by: { id: string; name: string } },
): Promise<{ id: string; created: boolean }> {
  if (input.sourceEntryId) {
    const [dup] = (await ctx.db.find(actionItems, { meetingId: meeting.id }) as ActionItem[]).filter((a) => a.sourceEntryId === input.sourceEntryId);
    if (dup) return { id: dup.id, created: false };
  }
  let assignee: { id: string; name: string } | null = null;
  if (input.assignee) {
    assignee = resolveAssignee(await participants(ctx, meeting), input.assignee);
    if (!assignee) fail("INVALID_ARGUMENT", `"${input.assignee}" is not the host, an invitee or an attendee of this meeting.`);
  }
  const id = await ctx.db.insert(actionItems, {
    meetingId: meeting.id,
    ...(input.callId ? { callId: input.callId } : {}),
    text: input.text.trim(),
    ...(assignee ? { assigneeId: assignee.id, assigneeName: assignee.name } : {}),
    ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    status: "open",
    source: input.source,
    ...(input.sourceEntryId ? { sourceEntryId: input.sourceEntryId } : {}),
    createdById: input.by.id,
    createdByName: input.by.name,
    createdAt: Date.now(),
  });
  if (assignee && assignee.id !== input.by.id) notifyAssigned(ctx, meeting, id, assignee.id, input.text, input.by.name);
  return { id, created: true };
}

export function notifyAssigned(ctx: any, meeting: Meeting, itemId: string, recipient: string, text: string, by: string) {
  ctx.afterCommit.notifications.send({ recipient, type: "actionitem.assigned", title: `${by} assigned you: ${text.slice(0, 120)}`, data: { code: meeting.code, item: itemId }, idempotencyKey: `assign:${itemId}:${recipient}` });
}

export async function addDecision(
  ctx: any,
  meeting: Meeting,
  input: { callId?: string; text: string; source: Decision["source"]; sourceEntryId?: string; by: { id: string; name: string } },
): Promise<{ id: string; created: boolean }> {
  const existing = (await ctx.db.find(decisions, { meetingId: meeting.id })) as Decision[];
  const dup = existing.find((d) => (input.sourceEntryId && d.sourceEntryId === input.sourceEntryId) || d.text.trim().toLowerCase() === input.text.trim().toLowerCase());
  if (dup) return { id: dup.id, created: false };
  const id = await ctx.db.insert(decisions, {
    meetingId: meeting.id,
    ...(input.callId ? { callId: input.callId } : {}),
    text: input.text.trim(),
    source: input.source,
    ...(input.sourceEntryId ? { sourceEntryId: input.sourceEntryId } : {}),
    madeById: input.by.id,
    madeByName: input.by.name,
    createdAt: Date.now(),
  });
  return { id, created: true };
}

/** The latest summary of a call, and how many earlier ones exist. */
export async function latestSummary(ctx: any, callId: string): Promise<{ summary: Summary | null; versions: number }> {
  const all = ((await ctx.db.find(summaries, { callId })) as Summary[]).sort((a, b) => b.createdAt - a.createdAt);
  return { summary: all[0] ?? null, versions: all.length };
}

/** Delete a meeting and everything that belongs to it. Callers check authority and that no call is running. */
export async function purgeMeeting(ctx: any, meeting: Meeting): Promise<number> {
  let removed = 0;
  const drop = async (collection: any, where: Record<string, unknown>) => {
    for (const row of await ctx.db.find(collection, where)) (await ctx.db.delete(collection, row.id)), removed++;
  };
  await drop(signals, { meetingId: meeting.id });
  await drop(peers, { meetingId: meeting.id });
  await drop(entries, { meetingId: meeting.id });
  await drop(actionItems, { meetingId: meeting.id });
  await drop(decisions, { meetingId: meeting.id });
  await drop(summaries, { meetingId: meeting.id });
  await drop(calls, { meetingId: meeting.id });
  await ctx.db.delete(meetings, meeting.id);
  return removed + 1;
}
