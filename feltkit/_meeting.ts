/** Meeting rules shared by the function modules. Not loaded as functions (leading underscore). */
import { fail } from "@feltdb/feltkit";
import { calls, entries, meetings, peers } from "./app.js";

/** A peer that has not checked in for this long has left (closed tab, lost network, crashed agent). */
export const LIVE_MS = 45_000;
export const REACTIONS = ["👍", "👏", "😂", "🎉", "❤️", "🤔"] as const;

type Principal = { id: string; type: string; displayName?: string };
export type Meeting = { id: string; code: string; title: string; hostId: string; hostName: string; access: "link" | "invited"; invited: string[]; scheduledFor?: number; createdAt: number };
export type Call = { id: string; meetingId: string; number: number; startedAt: number; endedAt?: number };
export type Peer = { id: string; meetingId: string; callId: string; principalId: string; name: string; kind: "person" | "agent"; joinedAt: number; lastSeenAt: number; leftAt?: number; mic: boolean; cam: boolean; screen: boolean; hand: boolean };

const LETTERS = "abcdefghijkmnopqrstuvwxyz";
export function newCode(): string {
  const pick = (n: number) => Array.from({ length: n }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

export function kindOf(p: Principal): "person" | "agent" {
  return p.type === "agent" ? "agent" : "person";
}

export function nameOf(p: Principal): string {
  return (p.displayName?.trim() || p.id).slice(0, 80);
}

export function mayAttend(meeting: Meeting, principalId: string): boolean {
  return meeting.access === "link" || meeting.hostId === principalId || meeting.invited.includes(principalId);
}

/** The meeting by code, if the caller may attend it. Unknown and forbidden look the same: a code is the secret. */
export async function meetingFor(ctx: any, code: string): Promise<Meeting> {
  const me = ctx.auth.requirePrincipal() as Principal;
  const [meeting] = (await ctx.db.find(meetings, { code: code.trim().toLowerCase() }, { limit: 1 })) as Meeting[];
  if (!meeting || !mayAttend(meeting, me.id)) fail("NOT_FOUND", "No meeting with that code, or you are not invited to it.");
  return meeting;
}

export async function latestCall(ctx: any, meetingId: string): Promise<Call | null> {
  const [call] = (await ctx.db.find(calls, { meetingId }, { orderBy: [{ field: "number", direction: "desc" }], limit: 1 })) as Call[];
  return call ?? null;
}

export function isLive(peer: Peer, now: number): boolean {
  return peer.leftAt === undefined && now - peer.lastSeenAt < LIVE_MS;
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

/**
 * Settle the open call: mark peers that stopped checking in as left (at their last check-in),
 * and end the call if no person remains (agents alone do not keep a call open).
 * Returns the call if it is still open.
 */
export async function settle(ctx: any, meeting: Meeting, now: number): Promise<Call | null> {
  const call = await latestCall(ctx, meeting.id);
  if (!call || call.endedAt !== undefined) return null;
  const all = (await ctx.db.find(peers, { callId: call.id })) as Peer[];
  for (const p of all) {
    if (p.leftAt === undefined && !isLive(p, now)) await ctx.db.patch(peers, p.id, { leftAt: p.lastSeenAt });
  }
  const people = all.filter((p) => p.kind === "person" && isLive(p, now));
  if (people.length > 0) return call;
  const lastSeen = Math.max(call.startedAt, ...all.map((p) => p.leftAt ?? Math.min(p.lastSeenAt, now)));
  await ctx.db.patch(calls, call.id, { endedAt: lastSeen });
  for (const p of all) if (p.leftAt === undefined) await ctx.db.patch(peers, p.id, { leftAt: Math.min(p.lastSeenAt, now) });
  return null;
}

/** The caller's own live peer, or a refusal. */
export async function ownPeer(ctx: any, peerId: string): Promise<Peer> {
  const me = ctx.auth.requirePrincipal() as Principal;
  const peer = (await ctx.db.get(peers, peerId)) as Peer | null;
  if (!peer || peer.principalId !== me.id) fail("NOT_FOUND", "That is not your connection to this call.");
  if (peer.leftAt !== undefined) fail("FAILED_PRECONDITION", "You are no longer in this call. Join again.");
  return peer;
}
