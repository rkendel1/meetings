import { fail, s } from "@feltdb/feltkit";
import { calls, entries, meetings, peers } from "./app.js";
import { isLive, latestCall, meetingFor, nameOf, newCode, type Call, type Meeting, type Peer } from "./_meeting.js";
import { CallOut, EntryOut, MeetingOut, PeerOut, strip, stripEntry, stripPeer } from "./_schemas.js";
import { app } from "./app.js";

const Summary = MeetingOut.extend({
  live: s.boolean(),
  attendees: s.integer(),
  lastCallAt: s.optional(s.number()),
});

/** Meetings you host or are invited to, soonest scheduled first, then most recent. */
export const list = app.query({
  access: "meetings.read",
  returns: s.array(Summary),
  capability: { name: "meetings.list", description: "Meetings you host or are invited to, with whether a call is live right now." },
  handler: async (ctx) => {
    const me = ctx.auth.requirePrincipal();
    // Hosted ones are index-backed. Invitations are an array field, read by scan: fine at team scale.
    const all = (await ctx.db.find(meetings, {})) as Meeting[];
    const mine = all.filter((m) => m.hostId === me.id || m.invited.includes(me.id));
    const now = Date.now();
    const out: Array<Meeting & { live: boolean; attendees: number; lastCallAt?: number }> = [];
    for (const m of mine) {
      const call = await latestCall(ctx, m.id);
      const open = call && call.endedAt === undefined;
      const live = open ? ((await ctx.db.find(peers, { callId: call!.id })) as Peer[]).filter((p) => isLive(p, now)) : [];
      out.push({ ...strip(m), createdAt: m.createdAt, live: live.some((p) => p.kind === "person"), attendees: live.length, ...(call ? { lastCallAt: call.startedAt } : {}) });
    }
    return out.sort((a, b) => Number(b.live) - Number(a.live) || (b.lastCallAt ?? b.createdAt) - (a.lastCallAt ?? a.createdAt));
  },
});

export const create = app.mutation({
  access: "meetings.create",
  args: {
    title: s.string({ minLength: 1, maxLength: 120 }),
    access: s.optional(s.enum(["link", "invited"] as const)),
    invited: s.optional(s.array(s.string({ minLength: 1, maxLength: 120 }), { maxItems: 100 })),
    scheduledFor: s.optional(s.number()),
  },
  returns: MeetingOut,
  handler: async (ctx, { title, access, invited, scheduledFor }) => {
    const me = ctx.auth.requirePrincipal();
    if (me.type === "agent") fail("FORBIDDEN", "Agents attend meetings; people create them.");
    let code = newCode();
    for (let i = 0; i < 5 && (await ctx.db.find(meetings, { code }, { limit: 1 })).length; i++) code = newCode();
    const guests = [...new Set((invited ?? []).map((x: string) => x.trim()).filter((x: string) => x && x !== me.id))];
    const record = { code, title: title.trim(), hostId: me.id, hostName: nameOf(me), access: access ?? "link", invited: guests, ...(scheduledFor ? { scheduledFor } : {}), createdAt: Date.now() };
    const id = await ctx.db.insert(meetings, record);
    for (const recipient of guests) {
      ctx.afterCommit.notifications.send({ recipient, type: "meeting.invited", title: `${nameOf(me)} invited you to "${record.title}"`, data: { code }, idempotencyKey: `invite:${id}:${recipient}` });
    }
    return { id, ...record };
  },
});

/** The host changes who may attend. */
export const update = app.mutation({
  access: "meetings.create",
  args: { code: s.string(), title: s.optional(s.string({ minLength: 1, maxLength: 120 })), access: s.optional(s.enum(["link", "invited"] as const)), invited: s.optional(s.array(s.string({ minLength: 1, maxLength: 120 }), { maxItems: 100 })) },
  returns: MeetingOut,
  handler: async (ctx, args) => {
    const meeting = await meetingFor(ctx, args.code);
    const me = ctx.auth.requirePrincipal();
    if (meeting.hostId !== me.id) fail("FORBIDDEN", "Only the host can change this meeting.");
    const invited = args.invited ? [...new Set(args.invited.map((x: string) => x.trim()).filter((x: string) => x && x !== me.id))] : meeting.invited;
    for (const recipient of invited.filter((x: string) => !meeting.invited.includes(x))) {
      ctx.afterCommit.notifications.send({ recipient, type: "meeting.invited", title: `${nameOf(me)} invited you to "${meeting.title}"`, data: { code: meeting.code }, idempotencyKey: `invite:${meeting.id}:${recipient}` });
    }
    const next = await ctx.db.patch(meetings, meeting.id, { ...(args.title ? { title: args.title.trim() } : {}), ...(args.access ? { access: args.access } : {}), invited });
    return strip(next);
  },
});

/** A meeting and its call right now: who is in it (people and agents) and what they share. */
export const get = app.query({
  access: "meetings.read",
  args: { code: s.string() },
  returns: s.object({ meeting: MeetingOut, call: s.nullable(CallOut), peers: s.array(PeerOut), calls: s.integer(), now: s.number() }),
  capability: { name: "meetings.get", description: "A meeting by code: its live call (if any) and who is in it right now, people and agents." },
  handler: async (ctx, { code }) => {
    const meeting = await meetingFor(ctx, code);
    const call = await latestCall(ctx, meeting.id);
    const now = Date.now();
    const open = call && call.endedAt === undefined ? call : null;
    const live = open ? ((await ctx.db.find(peers, { callId: open.id }, { orderBy: [{ field: "joinedAt", direction: "asc" }] })) as Peer[]).filter((p) => isLive(p, now)) : [];
    // An open call with no live person is over; the next join or leave records its end.
    const people = live.filter((p) => p.kind === "person");
    return { meeting: strip(meeting), call: people.length ? strip(open!) : null, peers: people.length ? live.map(stripPeer) : [], calls: call?.number ?? 0, now };
  },
});

/** The timeline after a point: chat, captions, reactions, notes, joins and leaves, in order. Agents poll this to follow a call. */
export const feed = app.query({
  access: "meetings.read",
  args: { code: s.string(), after: s.optional(s.integer({ minimum: 0 })), callNumber: s.optional(s.integer({ minimum: 1 })), limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  returns: s.object({ entries: s.array(EntryOut), next: s.integer() }),
  capability: { name: "meetings.feed", description: "The meeting timeline (chat, live captions of what people said, reactions, notes, joins/leaves) after sequence number `after`. Pass the returned `next` as `after` to follow along." },
  handler: async (ctx, { code, after, callNumber, limit }) => {
    const meeting = await meetingFor(ctx, code);
    const where: any[] = [{ field: "meetingId", eq: meeting.id }, { field: "seq", gt: after ?? 0 }];
    if (callNumber) {
      const [call] = await ctx.db.find(calls, { meetingId: meeting.id, number: callNumber }, { limit: 1 });
      if (!call) fail("NOT_FOUND", `This meeting has no call ${callNumber}.`);
      where.push({ field: "callId", eq: call.id });
    }
    const page = await ctx.db.query(entries, { where, orderBy: [{ field: "seq", direction: "asc" }], limit: limit ?? 200 });
    const list = page.records.map(stripEntry);
    return { entries: list, next: list.length ? list[list.length - 1].seq : after ?? 0 };
  },
});

const Attendee = s.object({ principalId: s.string(), name: s.string(), kind: s.enum(["person", "agent"] as const), firstJoinedAt: s.number(), lastLeftAt: s.number(), minutes: s.number(), devices: s.integer() });

/** What happened in one call: when, who attended and for how long, and its timeline. */
export const recap = app.query({
  access: "meetings.read",
  args: { code: s.string(), callNumber: s.optional(s.integer({ minimum: 1 })) },
  returns: s.object({ meeting: MeetingOut, call: CallOut, live: s.boolean(), attendance: s.array(Attendee), entries: s.array(EntryOut), calls: s.array(CallOut) }),
  capability: { name: "meetings.recap", description: "A call's recap: start/end, attendance per person and agent, and its full timeline (chat, captions, notes). Latest call unless callNumber is given." },
  handler: async (ctx, { code, callNumber }) => {
    const meeting = await meetingFor(ctx, code);
    const all = (await ctx.db.find(calls, { meetingId: meeting.id }, { orderBy: [{ field: "number", direction: "desc" }] })) as Call[];
    const call = callNumber ? all.find((c) => c.number === callNumber) : all[0];
    if (!call) fail("NOT_FOUND", callNumber ? `This meeting has no call ${callNumber}.` : "This meeting has not had a call yet.");
    const now = Date.now();
    const devices = (await ctx.db.find(peers, { callId: call.id })) as Peer[];
    const byWho = new Map<string, { principalId: string; name: string; kind: "person" | "agent"; firstJoinedAt: number; lastLeftAt: number; ms: number; devices: number }>();
    for (const p of devices) {
      const end = p.leftAt ?? (isLive(p, now) ? now : p.lastSeenAt);
      const a = byWho.get(p.principalId) ?? { principalId: p.principalId, name: p.name, kind: p.kind, firstJoinedAt: p.joinedAt, lastLeftAt: end, ms: 0, devices: 0 };
      a.firstJoinedAt = Math.min(a.firstJoinedAt, p.joinedAt);
      a.lastLeftAt = Math.max(a.lastLeftAt, end);
      a.ms += Math.max(0, end - p.joinedAt); // devices of one person can overlap; this is device time
      a.devices += 1;
      byWho.set(p.principalId, a);
    }
    const timeline = await ctx.db.find(entries, { callId: call.id }, { orderBy: [{ field: "seq", direction: "asc" }] });
    return {
      meeting: strip(meeting),
      call: strip(call),
      live: call.endedAt === undefined && devices.some((p) => p.kind === "person" && isLive(p, now)),
      attendance: [...byWho.values()].sort((a, b) => a.firstJoinedAt - b.firstJoinedAt).map(({ ms, ...a }) => ({ ...a, minutes: Math.round(ms / 6000) / 10 })),
      entries: timeline.map(stripEntry),
      calls: all.map(strip),
    };
  },
});
