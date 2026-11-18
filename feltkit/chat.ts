import { fail, s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { REACTIONS, append, latestCall, meetingFor, ownPeer, type Meeting } from "./_meeting.js";

const Posted = s.object({ id: s.string() });

async function openCallId(ctx: any, meeting: Meeting): Promise<string | undefined> {
  const call = await latestCall(ctx, meeting.id);
  return call && call.endedAt === undefined ? call.id : undefined;
}

export const send = app.mutation({
  access: "chat.send",
  args: { code: s.string(), text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: Posted,
  retry: { sequenceConflicts: 5 },
  capability: { name: "chat.send", description: "Post a chat message in the meeting (shown to everyone in the call, and kept in the recap)." },
  handler: async (ctx, { code, text }) => {
    const meeting = await meetingFor(ctx, code);
    if (!text.trim()) fail("INVALID_ARGUMENT", "Say something.");
    return { id: await append(ctx, meeting, { callId: await openCallId(ctx, meeting), kind: "chat", text: text.trim() }) };
  },
});

export const react = app.mutation({
  access: "chat.react",
  args: { code: s.string(), emoji: s.enum(REACTIONS) },
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

/** A finished caption line from the speaker's own browser (speech recognition runs there). People only. */
export const caption = app.mutation({
  access: "captions.write",
  args: { peerId: s.string(), code: s.string(), text: s.string({ minLength: 1, maxLength: 2000 }) },
  returns: Posted,
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { peerId, code, text }) => {
    const meeting = await meetingFor(ctx, code);
    const peer = await ownPeer(ctx, peerId);
    if (peer.meetingId !== meeting.id || peer.kind !== "person") fail("FORBIDDEN", "Only a person in this call captions their own speech.");
    return { id: await append(ctx, meeting, { callId: peer.callId, kind: "caption", text: text.trim(), author: { id: peer.principalId, name: peer.name, kind: "person" } }) };
  },
});

/** A note for the recap: a summary, a decision, action items. Agents use this to report what they heard. */
export const note = app.mutation({
  access: "notes.write",
  args: { code: s.string(), text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: Posted,
  retry: { sequenceConflicts: 5 },
  capability: { name: "notes.add", description: "Add a note to the meeting's recap (summary, decisions, action items). Shown in the call and in the recap." },
  handler: async (ctx, { code, text }) => {
    const meeting = await meetingFor(ctx, code);
    const call = await latestCall(ctx, meeting.id);
    return { id: await append(ctx, meeting, { callId: call?.id, kind: "note", text: text.trim() }) };
  },
});
