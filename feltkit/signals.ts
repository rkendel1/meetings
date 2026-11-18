/**
 * WebRTC signaling. Media flows browser to browser; FeltDB only carries each pair's offer and
 * answer (with ICE candidates gathered up front), then the recipient deletes them.
 *
 * Limits, enforced here because a signal makes the recipient's browser rebuild its connection:
 * - roles: of a pair, only the smaller connection id offers and only the larger answers;
 * - one pending signal of each kind per pair: a newer one replaces an unread one;
 * - a budget of SIGNALS_PER_MINUTE per sending connection (RATE_LIMITED beyond it);
 * - an SDP of at most 64 kB that looks like one.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, peers, signals } from "./app.js";
import { ownPeer, type Peer } from "./_meeting.js";

export const SIGNALS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

export const send = app.mutation({
  access: "signal.send",
  args: { fromPeer: s.string({ maxLength: 64 }), toPeer: s.string({ maxLength: 64 }), kind: s.enum(["offer", "answer"] as const), sdp: s.string({ minLength: 1, maxLength: 65_536 }) },
  returns: s.object({ id: s.string() }),
  handler: async (ctx, { fromPeer, toPeer, kind, sdp }) => {
    const from = await ownPeer(ctx, fromPeer);
    if (from.kind !== "person") fail("FORBIDDEN", "Only people's connections carry media.");
    const to = (await ctx.db.get(peers, toPeer)) as Peer | null;
    if (!to || to.callId !== from.callId || to.leftAt !== undefined || to.kind !== "person" || to.id === from.id) fail("NOT_FOUND", "That connection is not in your call.");
    if (kind === "offer" ? !(from.id < to.id) : !(from.id > to.id)) fail("FAILED_PRECONDITION", `In this pair, the other connection ${kind === "offer" ? "offers" : "answers"}.`);
    if (!/^v=0\r?\n/.test(sdp) || !/\r?\nm=(audio|video) /.test(sdp)) fail("INVALID_ARGUMENT", "That is not a session description.");

    const now = Date.now();
    const fresh = from.signalWindowAt === undefined || now - from.signalWindowAt >= WINDOW_MS;
    const count = fresh ? 1 : (from.signalCount ?? 0) + 1;
    if (count > SIGNALS_PER_MINUTE) fail("RATE_LIMITED", `Too much signaling from this connection: at most ${SIGNALS_PER_MINUTE} a minute.`, { retryAfterMs: from.signalWindowAt! + WINDOW_MS - now });
    await ctx.db.patch(peers, from.id, fresh ? { signalWindowAt: now, signalCount: 1 } : { signalCount: count });

    for (const old of await ctx.db.find(signals, { toPeer, fromPeer })) if (old.kind === kind) await ctx.db.delete(signals, old.id);
    return { id: await ctx.db.insert(signals, { meetingId: from.meetingId, fromPeer, toPeer, kind, sdp, createdAt: now }) };
  },
});

/** Signals waiting for this connection. Live: a new offer or answer arrives as soon as it is sent. */
export const inbox = app.query({
  access: "signal.read",
  args: { peerId: s.string({ maxLength: 64 }) },
  handler: async (ctx, { peerId }) => {
    const me = ctx.auth.requirePrincipal();
    const peer = (await ctx.db.get(peers, peerId)) as Peer | null;
    if (!peer || peer.principalId !== me.id || peer.leftAt !== undefined) return [];
    return (await ctx.db.find(signals, { toPeer: peerId }, { orderBy: [{ field: "createdAt", direction: "asc" }] })).map((x: any) => ({ id: x.id, fromPeer: x.fromPeer, kind: x.kind, sdp: x.sdp }));
  },
});

export const ack = app.mutation({
  access: "signal.read",
  args: { peerId: s.string({ maxLength: 64 }), ids: s.array(s.string({ maxLength: 64 }), { maxItems: 100 }) },
  handler: async (ctx, { peerId, ids }) => {
    await ownPeer(ctx, peerId);
    for (const id of ids) {
      const sig = await ctx.db.get(signals, id);
      if (sig && sig.toPeer === peerId) await ctx.db.delete(signals, id);
    }
  },
});
