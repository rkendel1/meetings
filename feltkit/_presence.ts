/**
 * Presence and call settlement: app-built infrastructure. FeltDB has no leases or time-based expiry,
 * and live queries do not re-run as time passes, so each connection refreshes `lastSeenAt` and the
 * next write that touches a call (join, leave, check-in) settles it. Kept apart from the meeting rules
 * so it can be replaced if the platform provides presence (see AUDIT.md, platform gaps).
 */
import { calls, peers, signals } from "./app.js";
import type { Call, LeftReason, Meeting, Peer } from "./_meeting.js";
import { latestCall } from "./_meeting.js";

/** A connection that has not checked in for this long is gone (closed tab, lost network, crashed agent). */
export const LIVE_MS = 45_000;
/**
 * A call with no person in it stays open this long after the last person's last sign of life, so a
 * refresh or a brief network drop does not end it (agents alone never keep it open longer).
 * Pressing Leave as the last person ends it at once.
 */
export const GRACE_MS = 60_000;
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
 * Settle the latest call: connections that stopped checking in are marked expired (at their last
 * check-in), and the call is ended when no person is left and either `final` (the last person pressed
 * Leave) or the grace period has passed. Returns the call if it is still open.
 */
export async function settle(ctx: any, meeting: Meeting, now: number, options: { final?: boolean } = {}): Promise<Call | null> {
  const call = await latestCall(ctx, meeting.id);
  if (!call || call.endedAt !== undefined) return null;
  const state = await callState(ctx, call, now);
  for (const p of state.peers) if (p.leftAt === undefined && !isLive(p, now)) await endPeer(ctx, p, p.lastSeenAt, "expired");
  if (state.people.length > 0) return call;
  if (!options.final && now - state.lastPersonAt < GRACE_MS) return call;
  const endedAt = options.final ? now : Math.min(now, state.lastPersonAt + GRACE_MS);
  await ctx.db.patch(calls, call.id, { endedAt });
  for (const p of state.peers) if (p.leftAt === undefined && isLive(p, now)) await endPeer(ctx, p, endedAt, "ended");
  return null;
}

