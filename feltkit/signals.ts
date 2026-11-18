/**
 * WebRTC signaling. Media flows browser to browser; FeltDB only carries each pair's offer and
 * answer (with ICE candidates gathered up front), then the recipient deletes them.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, peers, signals } from "./app.js";
import { ownPeer, type Peer } from "./_meeting.js";

export const send = app.mutation({
  access: "signal.send",
  args: { fromPeer: s.string(), toPeer: s.string(), kind: s.enum(["offer", "answer"] as const), sdp: s.string({ minLength: 1, maxLength: 200_000 }) },
  returns: s.object({ id: s.string() }),
  handler: async (ctx, { fromPeer, toPeer, kind, sdp }) => {
    const from = await ownPeer(ctx, fromPeer);
    const to = (await ctx.db.get(peers, toPeer)) as Peer | null;
    if (!to || to.callId !== from.callId || to.leftAt !== undefined || to.kind !== "person") fail("NOT_FOUND", "That connection is not in your call.");
    return { id: await ctx.db.insert(signals, { meetingId: from.meetingId, fromPeer, toPeer, kind, sdp, createdAt: Date.now() }) };
  },
});

/** Signals waiting for this connection. Live: a new offer or answer arrives as soon as it is sent. */
export const inbox = app.query({
  access: "signal.read",
  args: { peerId: s.string() },
  handler: async (ctx, { peerId }) => {
    const me = ctx.auth.requirePrincipal();
    const peer = (await ctx.db.get(peers, peerId)) as Peer | null;
    if (!peer || peer.principalId !== me.id) return [];
    return (await ctx.db.find(signals, { toPeer: peerId }, { orderBy: [{ field: "createdAt", direction: "asc" }] })).map((x: any) => ({ id: x.id, fromPeer: x.fromPeer, kind: x.kind, sdp: x.sdp }));
  },
});

export const ack = app.mutation({
  access: "signal.read",
  args: { peerId: s.string(), ids: s.array(s.string(), { maxItems: 100 }) },
  handler: async (ctx, { peerId, ids }) => {
    await ownPeer(ctx, peerId);
    for (const id of ids) {
      const sig = await ctx.db.get(signals, id);
      if (sig && sig.toPeer === peerId) await ctx.db.delete(signals, id);
    }
  },
});
