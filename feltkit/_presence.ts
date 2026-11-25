/**
 * Presence and call settlement: app-built infrastructure. FeltDB has no leases or time-based expiry,
 * and live queries do not re-run as time passes, so each connection refreshes `lastSeenAt` and the
 * next write that touches a call (join, leave, check-in) settles it. Kept apart from the meeting rules
 * so it can be replaced if the platform provides presence (see AUDIT.md, platform gaps).
 */
import { s } from "@feltdb/feltkit";
import { app, calls } from "./app.js";
import { signals } from "./signals.js";
import type { Call, LeftReason, Meeting, Peer } from "./_meeting.js";
import { append, latestCall } from "./_meeting.js";

/** A connected device (a person's browser tab) or an attending agent, in one call. */
export const peers = app.collection(
  "peers",
  {
    meetingId: s.ref("meetings"),
    callId: s.ref("calls"),
    principalId: s.string(),
    name: s.string({ minLength: 1, maxLength: 80 }),
    kind: s.enum(["person", "agent"] as const),
    joinedAt: s.number(),
    lastSeenAt: s.number(),
    leftAt: s.optional(s.number()),
    // Why the connection ended: left (pressed Leave or closed the tab), replaced (a refresh or a new tab of the
    // same device took over), expired (stopped checking in), removed (by the host, or access was revoked), ended.
    leftReason: s.optional(s.enum(["left", "replaced", "expired", "removed", "ended", "session-ended"] as const)),
    // The session that created this connection (FeltKit ctx.auth.session.ref, where the platform provides it).
    // Only that session may keep it alive, and it ends when that session ends (calls:sessionEnded).
    sessionRef: s.optional(s.string({ maxLength: 64 })),
    // Signaling budget: a fixed one-minute window per connection (feltkit/signals.ts).
    signalWindowAt: s.optional(s.number()),
    signalCount: s.optional(s.integer({ minimum: 0 })),
    mic: s.boolean(),
    cam: s.boolean(),
    screen: s.boolean(),
    hand: s.boolean(),
  },
  { indexes: [{ fields: ["callId"] }, { fields: ["meetingId"] }, { fields: ["principalId"] }] },
);

/** A connection that has not checked in for this long is gone (closed tab, lost network, crashed agent). */
export const LIVE_MS = 45_000;
/**
 * A call with no person in it stays open this long after the last person's last sign of life, so a
 * refresh or a brief network drop does not end it (agents alone never keep it open longer).
 * Pressing Leave as the last person ends it at once.
 */
export const GRACE_MS = 60_000;
/**
 * A call people stay connected to but nobody uses (a forgotten tab): after this long with no activity from a person,
 * everyone is asked "Still here?", and the call ends IDLE_WARNING_MS later unless a person shows activity. The server
 * decides both (enforceIdle); the browser only shows the prompt.
 */
export const IDLE_MS = 15 * 60_000;
export const IDLE_WARNING_MS = 2 * 60_000;
/** Activity is written at most this often (a caption per sentence would otherwise rewrite the call every few seconds). */
const ACTIVITY_WRITE_MS = 30_000;

export function isLive(peer: Peer, now: number): boolean {
  return peer.leftAt === undefined && now - peer.lastSeenAt < LIVE_MS;
}

export type CallState = { call: Call; peers: Peer[]; live: Peer[]; people: Peer[]; open: boolean; lastPersonAt: number };

/** What a call is right now, from its connections, without writing anything (usable in queries). */
export async function callState(ctx: any, call: Call, now: number): Promise<CallState> {
  const all = (await ctx.db.find(peers, { callId: call.id }, { orderBy: [{ field: "joinedAt", direction: "asc" }] })) as Peer[];
  const live = all.filter((p) => isLive(p, now));
  const people = live.filter((p) => p.kind === "person");
  const lastPersonAt = Math.max(call.startedAt, ...all.filter((p) => p.kind === "person").map((p) => p.leftAt ?? p.lastSeenAt));
  const open = call.endedAt === undefined && (people.length > 0 || now - lastPersonAt < GRACE_MS);
  return { call, peers: all, live: open ? live : [], people, open, lastPersonAt };
}

/** End a connection, and drop the signaling waiting for it. */
export async function endPeer(ctx: any, peer: Peer, at: number, reason: LeftReason) {
  await ctx.db.patch(peers, peer.id, { leftAt: at, leftReason: reason });
  for (const sig of await ctx.db.find(signals, { toPeer: peer.id })) await ctx.db.delete(signals, sig.id);
}

/**
 * End a call: stamp it, stop a recording still running, and hand the finished call to the scribe (feltkit/agents.ts),
 * which writes its recap after this commits. Every way a call ends goes through here.
 */
export async function finishCall(ctx: any, call: Call, endedAt: number) {
  const recording = call.recording && call.recording.stoppedAt === undefined ? { recording: { ...call.recording, stoppedAt: endedAt } } : {};
  await ctx.db.patch(calls, call.id, { endedAt, open: false, idleEndsAt: 0, ...recording });
  ctx.afterCommit.agent("scribe", { callId: call.id });
}

/** Whether the "Still here?" prompt is showing for this call, and until when. */
export const idleEndsAt = (call: Call): number | undefined => ((call.idleEndsAt ?? 0) > 0 ? call.idleEndsAt : undefined);

/** Whether the idle check has anything to do: the prompt is showing, or nobody has shown activity for IDLE_MS. */
export function idleDue(call: Call, now: number): boolean {
  return call.endedAt === undefined && (idleEndsAt(call) !== undefined || now - (call.lastActivityAt ?? call.startedAt) >= IDLE_MS);
}

/**
 * A person showed activity (spoke or captioned, chatted, reacted, started or stopped sharing, changed mic or camera,
 * joined, or answered the prompt): the idle clock restarts and a showing prompt goes away. Only people call this: an
 * agent's activity never keeps a call alive. Once the prompt's time has run out, activity no longer saves the call (the
 * next check ends it), so the end does not depend on who writes first.
 */
export async function noteActivity(ctx: any, call: Call, now: number): Promise<void> {
  if (call.endedAt !== undefined) return;
  const ends = idleEndsAt(call);
  if (ends !== undefined && now >= ends) return;
  if (ends === undefined && call.lastActivityAt !== undefined && now - call.lastActivityAt < ACTIVITY_WRITE_MS) return;
  await ctx.db.patch(calls, call.id, { lastActivityAt: now, idleEndsAt: 0 });
}

const SYSTEM = { id: "meetings", name: "Meetings", kind: "agent" as const };

/**
 * The idle rule, enforced here and nowhere else: with nobody having shown activity for IDLE_MS, show the prompt (write
 * the time the call ends); when that time has passed, end the call through finishCall (the recording stops, the scribe
 * writes the recap). Called with a call people are connected to, by whatever writes next: a heartbeat, a join, or the
 * maintenance sweep, so it does not depend on any browser running a timer.
 */
export async function enforceIdle(ctx: any, meeting: Meeting, call: Call, now: number): Promise<"ok" | "warned" | "ended"> {
  if (call.endedAt !== undefined) return "ended";
  const ends = idleEndsAt(call);
  if (ends !== undefined) {
    if (now < ends) return "warned";
    for (const p of (await ctx.db.find(peers, { callId: call.id })) as Peer[]) if (p.leftAt === undefined) await endPeer(ctx, p, ends, "ended");
    await finishCall(ctx, call, ends);
    await append(ctx, meeting, { callId: call.id, kind: "system", text: "The call ended: no one was active for 15 minutes and no one said they were still here", author: SYSTEM });
    return "ended";
  }
  if (now - (call.lastActivityAt ?? call.startedAt) < IDLE_MS) return "ok";
  await ctx.db.patch(calls, call.id, { idleEndsAt: now + IDLE_WARNING_MS });
  await append(ctx, meeting, { callId: call.id, kind: "system", text: "Still here? No one has been active for 15 minutes. The call ends in 2 minutes unless someone says they are still here", author: SYSTEM });
  return "warned";
}

/**
 * Settle the latest call: connections that stopped checking in are marked expired (at their last
 * check-in), and the call is ended when no person is left and either `final` (the last person pressed
 * Leave) or the grace period has passed. A call people are still connected to is checked for inactivity.
 * Returns the call if it is still open.
 */
export async function settle(ctx: any, meeting: Meeting, now: number, options: { final?: boolean } = {}): Promise<Call | null> {
  const call = await latestCall(ctx, meeting.id);
  if (!call || call.endedAt !== undefined) return null;
  const state = await callState(ctx, call, now);
  for (const p of state.peers) if (p.leftAt === undefined && !isLive(p, now)) await endPeer(ctx, p, p.lastSeenAt, "expired");
  if (state.people.length > 0) return (await enforceIdle(ctx, meeting, call, now)) === "ended" ? null : call;
  if (!options.final && now - state.lastPersonAt < GRACE_MS) return call;
  const endedAt = options.final ? now : Math.min(now, state.lastPersonAt + GRACE_MS);
  await finishCall(ctx, call, endedAt);
  for (const p of state.peers) if (p.leftAt === undefined && isLive(p, now)) await endPeer(ctx, p, endedAt, "ended");
  return null;
}
