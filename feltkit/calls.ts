import { fail, s } from "@feltdb/feltkit";
import { app, calls } from "./app.js";
import { peers } from "./_presence.js";
import { append, endPeer, finishCall, isLive, kindOf, latestCall, meetingFor, nameOf, ownPeer, sessionRefOf, settle, type Meeting, type Peer } from "./_meeting.js";
import { meetings } from "./app.js";

const Joined = s.object({ peerId: s.string(), callId: s.string(), callNumber: s.integer(), started: s.boolean() });

/**
 * Join the meeting's call. A person starts it if none is running; each browser tab is its own
 * connection, and `replaces` hands over from the caller's previous connection (a page refresh).
 * An agent attends a running call (presence only, no media); calling join again while attending
 * refreshes its presence, so an agent uses join as its check-in.
 */
export const join = app.mutation({
  access: "meetings.attend",
  args: {
    code: s.string({ maxLength: 64 }),
    mic: s.optional(s.boolean()),
    cam: s.optional(s.boolean()),
    replaces: s.optional(s.string()),
  },
  returns: Joined,
  retry: { sequenceConflicts: 5 },
  capability: { name: "meetings.join", description: "Attend the meeting's live call. Agents get presence (shown as an AI agent) and no media; call it again at least every 30 s to stay present, and read what is said with meetings.feed." },
  handler: async (ctx, { code, mic, cam, replaces }) => {
    const meeting = await meetingFor(ctx, code);
    const me = ctx.auth.requirePrincipal();
    const kind = kindOf(me);
    const now = Date.now();
    if (replaces) {
      const old = (await ctx.db.get(peers, replaces)) as Peer | null;
      if (old && old.principalId === me.id && old.meetingId === meeting.id && old.leftAt === undefined) await endPeer(ctx, old, now, "replaced");
    }
    let call = await settle(ctx, meeting, now);
    let started = false;
    if (!call) {
      if (kind === "agent") fail("FAILED_PRECONDITION", "No call is running in this meeting. Agents attend calls people have started; check meetings.get.");
      const previous = await latestCall(ctx, meeting.id);
      const number = (previous?.number ?? 0) + 1;
      const id = await ctx.db.insert(calls, { meetingId: meeting.id, number, startedAt: now, open: true });
      call = { id, meetingId: meeting.id, number, startedAt: now, open: true };
      started = true;
    }
    // The name everyone sees, and that captions and the recap are attributed to, is the principal's own:
    // never a name the request chooses, so nobody can speak as someone else.
    const display = nameOf(me);
    if (kind === "agent") {
      const [mine] = ((await ctx.db.find(peers, { callId: call.id, principalId: me.id })) as Peer[]).filter((p) => isLive(p, now) && (!p.sessionRef || p.sessionRef === sessionRefOf(ctx)));
      if (mine) {
        await ctx.db.patch(peers, mine.id, { lastSeenAt: now });
        return { peerId: mine.id, callId: call.id, callNumber: call.number, started: false };
      }
    }
    const sessionRef = sessionRefOf(ctx);
    const peerId = await ctx.db.insert(peers, {
      meetingId: meeting.id, callId: call.id, principalId: me.id, name: display, kind,
      ...(sessionRef ? { sessionRef } : {}),
      joinedAt: now, lastSeenAt: now, mic: kind === "person" && Boolean(mic), cam: kind === "person" && Boolean(cam), screen: false, hand: false,
    });
    if (!replaces) await append(ctx, meeting, { callId: call.id, kind: "system", text: `${display} joined${kind === "agent" ? " (AI agent)" : ""}`, author: { id: me.id, name: display, kind } });
    return { peerId, callId: call.id, callNumber: call.number, started };
  },
});

/** Stay in the call, and publish what this connection is sharing. Every 15 s from each tab. */
export const heartbeat = app.mutation({
  access: "meetings.attend",
  args: { peerId: s.string(), mic: s.optional(s.boolean()), cam: s.optional(s.boolean()), screen: s.optional(s.boolean()), hand: s.optional(s.boolean()) },
  returns: s.object({ ok: s.boolean() }),
  handler: async (ctx, { peerId, mic, cam, screen, hand }) => {
    const peer = await ownPeer(ctx, peerId);
    const call = await ctx.db.get(calls, peer.callId);
    if (!call || call.endedAt !== undefined) fail("FAILED_PRECONDITION", "This call has ended.", { reason: "ended" });
    const media = peer.kind === "person" ? { ...(mic !== undefined ? { mic } : {}), ...(cam !== undefined ? { cam } : {}), ...(screen !== undefined ? { screen } : {}) } : {};
    await ctx.db.patch(peers, peer.id, { lastSeenAt: Date.now(), ...media, ...(hand !== undefined ? { hand } : {}) });
    return { ok: true };
  },
});

/**
 * Leave the call. `final: false` is a tab closing or reloading: the connection ends, but if it was the
 * last person the call stays open for the grace period (a refresh rejoins the same call).
 */
export const leave = app.mutation({
  access: "meetings.attend",
  args: { code: s.string({ maxLength: 64 }), peerId: s.optional(s.string()), final: s.optional(s.boolean()) },
  returns: s.object({ callEnded: s.boolean() }),
  retry: { sequenceConflicts: 5 },
  capability: { name: "meetings.leave", description: "Leave the meeting's call (an agent leaves all its presence in it)." },
  handler: async (ctx, { code, peerId, final }) => {
    const meeting = await meetingFor(ctx, code);
    const me = ctx.auth.requirePrincipal();
    const now = Date.now();
    const call = await latestCall(ctx, meeting.id);
    if (!call || call.endedAt !== undefined) return { callEnded: true };
    const mine = ((await ctx.db.find(peers, { callId: call.id, principalId: me.id })) as Peer[]).filter((p) => p.leftAt === undefined && (!peerId || p.id === peerId));
    for (const p of mine) await endPeer(ctx, p, now, "left");
    if (mine.length && final !== false) await append(ctx, meeting, { callId: call.id, kind: "system", text: `${mine[0]!.name} left` });
    const open = await settle(ctx, meeting, now, { final: final !== false && mine.some((p) => p.kind === "person") });
    return { callEnded: open === null };
  },
});

/** The host ends the call for everyone, or removes one connection. */
export const end = app.mutation({
  access: "meetings.host",
  args: { code: s.string({ maxLength: 64 }), peerId: s.optional(s.string()) },
  returns: s.object({ ok: s.boolean() }),
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { code, peerId }) => {
    const meeting = await meetingFor(ctx, code);
    const me = ctx.auth.requirePrincipal();
    if (meeting.hostId !== me.id) fail("FORBIDDEN", "Only the host can end the call or remove someone.");
    const call = await latestCall(ctx, meeting.id);
    if (!call || call.endedAt !== undefined) return { ok: true };
    const now = Date.now();
    const all = ((await ctx.db.find(peers, { callId: call.id })) as Peer[]).filter((p) => p.leftAt === undefined && (!peerId || p.id === peerId));
    if (peerId) {
      if (all[0]) {
        await endPeer(ctx, all[0], now, "removed");
        await append(ctx, meeting, { callId: call.id, kind: "system", text: `${all[0].name} was removed by the host` });
      }
      await settle(ctx, meeting, now);
    } else {
      for (const p of all) await endPeer(ctx, p, now, "ended");
      await finishCall(ctx, call, now);
      await append(ctx, meeting, { callId: call.id, kind: "system", text: "The host ended the call" });
    }
    return { ok: true };
  },
});

/**
 * FeltKit calls this when one of the caller's sessions ends (feltkit({ auth: { onSessionEnd } }): signed out,
 * revoked, rotated or expired). Every connection that session created ends now, so everyone else's live
 * view drops it and closes their media to it. Safe to call directly: it ends only the caller's own
 * connections bound to the named session.
 */
export const sessionEnded = app.mutation({
  access: "meetings.attend",
  args: { session: s.string({ minLength: 1, maxLength: 64 }), reason: s.optional(s.string({ maxLength: 32 })) },
  returns: s.object({ ended: s.integer() }),
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { session }) => {
    const me = ctx.auth.requirePrincipal();
    const now = Date.now();
    const mine = ((await ctx.db.find(peers, { principalId: me.id })) as Peer[]).filter((p) => p.leftAt === undefined && p.sessionRef === session);
    const touched = new Map<string, Meeting>();
    for (const p of mine) {
      await endPeer(ctx, p, now, "session-ended");
      const meeting = (await ctx.db.get(meetings, p.meetingId)) as Meeting | null;
      if (meeting) {
        touched.set(meeting.id, meeting);
        await append(ctx, meeting, { callId: p.callId, kind: "system", text: `${p.name} left (session ended)`, author: { id: me.id, name: p.name, kind: p.kind } });
      }
    }
    // An ended session cannot come back to these connections, so no grace period: like pressing Leave.
    const final = mine.some((p) => p.kind === "person");
    for (const meeting of touched.values()) await settle(ctx, meeting, now + 1, { final });
    return { ended: mine.length };
  },
});
