import { fail, s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { callState, latestCall, meetingFor, nameOf } from "./_meeting.js";

/**
 * A person has the assistant answer in the meeting. The answer comes from the person's own request (feltkit/ai.ts,
 * as them); this puts it in the timeline as the assistant, an agent with its own identity, after this commits.
 */
export const say = app.mutation({
  access: "ai.use",
  args: { code: s.string({ maxLength: 64 }), question: s.string({ minLength: 1, maxLength: 500 }), answer: s.string({ minLength: 1, maxLength: 3000 }) },
  returns: s.object({ queued: s.boolean() }),
  handler: async (ctx, { code, question, answer }) => {
    const meeting = await meetingFor(ctx, code);
    const me = ctx.auth.requirePrincipal();
    if (me.type !== "user") fail("FORBIDDEN", "People ask the assistant.");
    const call = await latestCall(ctx, meeting.id);
    const state = call ? await callState(ctx, call, Date.now()) : null;
    if (meeting.hostId !== me.id && !state?.live.some((p) => p.principalId === me.id)) fail("FORBIDDEN", "Join the call to ask the assistant in it.");
    ctx.afterCommit.agent("assistant", { code: meeting.code, question, answer, askedBy: nameOf(me) });
    return { queued: true };
  },
});
