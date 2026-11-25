import { fail, s } from "@feltdb/feltkit";
import { app, calls } from "./app.js";
import { REACTIONS, append, callState, kindOf, latestCall, meetingFor, noteActivity, ownPeer, type Call, type Meeting } from "./_meeting.js";
import { notifyAgents } from "./orgagents.js";

const Posted = s.object({ id: s.string() });

/**
 * The running call a message belongs to. Posting into a running call needs presence in it (or being
 * the host): nobody speaks into a call without being seen in it. A person posting is activity (an agent never is).
 */
async function openCallId(ctx: any, meeting: Meeting): Promise<string | undefined> {
  const call = await latestCall(ctx, meeting.id);
  if (!call || call.endedAt !== undefined) return undefined;
  const now = Date.now();
  const state = await callState(ctx, call, now);
  if (!state.open) return undefined;
  const me = ctx.auth.requirePrincipal();
  if (meeting.hostId !== me.id && !state.live.some((p) => p.principalId === me.id)) fail("FORBIDDEN", "Join the call to post in it.");
  if (kindOf(me) === "person") await noteActivity(ctx, call, now);
  return call.id;
}

export const send = app.mutation({
  access: "chat.send",
  args: { code: s.string({ maxLength: 64 }), text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: Posted,
  retry: { sequenceConflicts: 5 },
  capability: { name: "chat.send", description: "Post a chat message in the meeting (shown to everyone in the call, and kept in the recap). During a call, only those in it may post (join first)." },
  handler: async (ctx, { code, text }) => {
    const meeting = await meetingFor(ctx, code);
    if (!text.trim()) fail("INVALID_ARGUMENT", "Say something.");
    const id = await append(ctx, meeting, { callId: await openCallId(ctx, meeting), kind: "chat", text: text.trim() });
    await notifyAgents(ctx, meeting.id);
    return { id };
  },
});

export const react = app.mutation({
  access: "chat.react",
  args: { code: s.string({ maxLength: 64 }), emoji: s.enum(REACTIONS) },
  returns: Posted,
  retry: { sequenceConflicts: 5 },
  capability: { name: "chat.react", description: `React in the call with one of ${REACTIONS.join(" ")}.` },
  handler: async (ctx, { code, emoji }) => {
    const meeting = await meetingFor(ctx, code);
    const callId = await openCallId(ctx, meeting);
    if (!callId) fail("FAILED_PRECONDITION", "Reactions are for a live call.");
    return { id: await append(ctx, meeting, { callId, kind: "reaction", text: emoji }) };
  },
});

/** A finished caption line from the speaker's own browser (speech recognition runs there). People only. Speech is activity. */
export const caption = app.mutation({
  access: "captions.write",
  args: { peerId: s.string(), code: s.string(), text: s.string({ minLength: 1, maxLength: 2000 }) },
  returns: Posted,
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { peerId, code, text }) => {
    const meeting = await meetingFor(ctx, code);
    const peer = await ownPeer(ctx, peerId);
    if (peer.meetingId !== meeting.id || peer.kind !== "person") fail("FORBIDDEN", "Only a person in this call captions their own speech.");
    const call = (await ctx.db.get(calls, peer.callId)) as Call | null;
    if (call) await noteActivity(ctx, call, Date.now());
    return { id: await append(ctx, meeting, { callId: peer.callId, kind: "caption", text: text.trim(), author: { id: peer.principalId, name: peer.name, kind: "person" } }) };
  },
});

/** A note for the recap: a summary, a decision, action items. Agents use this to report what they heard. */
export const note = app.mutation({
  access: "notes.write",
  args: { code: s.string({ maxLength: 64 }), text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: Posted,
  retry: { sequenceConflicts: 5 },
  capability: { name: "notes.add", description: "Add a note to the meeting's recap (summary, decisions, action items). Shown in the call and in the recap." },
  handler: async (ctx, { code, text }) => {
    const meeting = await meetingFor(ctx, code);
    const call = await latestCall(ctx, meeting.id);
    return { id: await append(ctx, meeting, { callId: call?.id, kind: "note", text: text.trim() }) };
  },
});
