/** Meeting rules shared by the function modules. Not loaded as functions (leading underscore). */
import { fail } from "@feltdb/feltkit";
import { calls, entries, meetings } from "./app.js";
import { peers } from "./_presence.js";
import { GRACE_MS, LIVE_MS, callState, endPeer, isLive, settle, type CallState } from "./_presence.js";
export { GRACE_MS, LIVE_MS, callState, endPeer, isLive, settle, type CallState };

export const REACTIONS = ["👍", "👏", "😂", "🎉", "❤️", "🤔"] as const;

type Principal = { id: string; type: string; displayName?: string };
export type LeftReason = "left" | "replaced" | "expired" | "removed" | "ended" | "session-ended";
export type Meeting = { id: string; code: string; title: string; hostId: string; hostName: string; access: "link" | "invited"; invited: string[]; scheduledFor?: number; createdAt: number };
export type Call = { id: string; meetingId: string; number: number; startedAt: number; endedAt?: number };
export type Peer = { id: string; meetingId: string; callId: string; principalId: string; name: string; kind: "person" | "agent"; joinedAt: number; lastSeenAt: number; leftAt?: number; leftReason?: LeftReason; sessionRef?: string; signalWindowAt?: number; signalCount?: number; mic: boolean; cam: boolean; screen: boolean; hand: boolean };

const LETTERS = "abcdefghijkmnopqrstuvwxyz";
export function newCode(): string {
  const pick = (n: number) => Array.from({ length: n }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

/**
 * People are signed-in users. Every other principal (agent sessions, API keys, services) is an agent:
 * it attends without media and never counts as a person, whatever roles it holds.
 */
export function kindOf(p: Principal): "person" | "agent" {
  return p.type === "user" ? "person" : "agent";
}

export function nameOf(p: Principal): string {
  return (p.displayName?.trim() || p.id).slice(0, 80);
}

export function mayAttend(meeting: Meeting, principalId: string): boolean {
  return meeting.access === "link" || meeting.hostId === principalId || meeting.invited.includes(principalId);
}

async function byCode(ctx: any, code: string): Promise<Meeting | null> {
  const [meeting] = (await ctx.db.find(meetings, { code: code.trim().toLowerCase() }, { limit: 1 })) as Meeting[];
  return meeting ?? null;
}

/** The meeting by code, if the caller may attend it. Unknown and forbidden look the same: a code is the secret. */
export async function meetingFor(ctx: any, code: string): Promise<Meeting> {
  const me = ctx.auth.requirePrincipal() as Principal;
  const meeting = await byCode(ctx, code);
  if (!meeting || !mayAttend(meeting, me.id)) fail("NOT_FOUND", "No meeting with that code, or you are not invited to it.");
  return meeting;
}

export async function latestCall(ctx: any, meetingId: string): Promise<Call | null> {
  const [call] = (await ctx.db.find(calls, { meetingId }, { orderBy: [{ field: "number", direction: "desc" }], limit: 1 })) as Call[];
  return call ?? null;
}

const GONE: Record<LeftReason, string> = {
  left: "You left this call.",
  replaced: "This connection was replaced by a newer one.",
  expired: "Your connection timed out. Join again.",
  removed: "You were removed from this call.",
  ended: "This call has ended.",
  "session-ended": "Your session ended. Sign in again to rejoin.",
};

/** The caller's session reference, when the platform provides one (FeltKit ctx.auth.session). */
export function sessionRefOf(ctx: any): string | undefined {
  const ref = ctx.auth?.session?.ref;
  return typeof ref === "string" && ref ? ref : undefined;
}

/** The caller's own connection, still in the call and still allowed in the meeting, or a refusal. */
export async function ownPeer(ctx: any, peerId: string): Promise<Peer> {
  const me = ctx.auth.requirePrincipal() as Principal;
  const peer = (await ctx.db.get(peers, peerId)) as Peer | null;
  if (!peer || peer.principalId !== me.id) fail("NOT_FOUND", "That is not your connection to this call.");
  // A connection is kept alive only by the session that created it: another session of the same person
  // (another tab after sign-in, a replayed request) cannot revive or extend it.
  if (peer.sessionRef && peer.sessionRef !== sessionRefOf(ctx)) fail("FAILED_PRECONDITION", "This connection belongs to another session. Join again.", { reason: "session" });
  const meeting = (await ctx.db.get(meetings, peer.meetingId)) as Meeting | null;
  if (!meeting || !mayAttend(meeting, me.id)) fail("FAILED_PRECONDITION", GONE.removed, { reason: "removed" });
  if (peer.leftAt !== undefined) fail("FAILED_PRECONDITION", GONE[peer.leftReason ?? "left"], { reason: peer.leftReason ?? "left" });
  if (!isLive(peer, Date.now())) fail("FAILED_PRECONDITION", GONE.expired, { reason: "expired" });
  return peer;
}

/**
 * Who may read a call's timeline (chat, captions, notes). While the call runs: the host, and whoever
 * is visibly in it right now; nobody follows a call without being seen in it. Afterwards: the host,
 * invitees, and whoever attended.
 */
export async function mayReadCall(ctx: any, meeting: Meeting, call: Call, principalId: string, now: number): Promise<boolean> {
  if (meeting.hostId === principalId) return true;
  const state = await callState(ctx, call, now);
  if (state.open) return state.live.some((p) => p.principalId === principalId);
  return meeting.invited.includes(principalId) || state.peers.some((p) => p.principalId === principalId);
}

/** Append to the meeting's timeline, ordered per meeting. */
export async function append(ctx: any, meeting: Meeting, entry: { callId?: string; kind: "chat" | "caption" | "reaction" | "note" | "system"; text: string; author?: { id: string; name: string; kind: "person" | "agent" } }) {
  const me = entry.author ?? (() => { const p = ctx.auth.requirePrincipal() as Principal; return { id: p.id, name: nameOf(p), kind: kindOf(p) }; })();
  const seq = await ctx.db.sequence(`meeting:${meeting.id}`);
  return ctx.db.insert(entries, {
    meetingId: meeting.id,
    ...(entry.callId ? { callId: entry.callId } : {}),
    seq,
    kind: entry.kind,
    authorId: me.id,
    authorName: me.name,
    authorKind: me.kind,
    text: entry.text,
    createdAt: Date.now(),
  });
}
