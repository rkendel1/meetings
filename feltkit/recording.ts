/**
 * Recording is the host's browser capturing the call (src/recorder.ts) and saving the file on the host's device.
 * The server keeps the part that must be trustworthy for everyone else: that a recording is on, who started it and
 * when, shown to every participant (people and agents) and written into the timeline. No media reaches the server.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, calls } from "./app.js";
import { append, latestCall, meetingFor, nameOf } from "./_meeting.js";

async function runningCall(ctx: any, meeting: any) {
  const me = ctx.auth.requirePrincipal();
  if (meeting.hostId !== me.id) fail("FORBIDDEN", "Only the host starts or stops a recording.");
  const call = await latestCall(ctx, meeting.id);
  if (!call || call.endedAt !== undefined) fail("FAILED_PRECONDITION", "There is no running call to record.");
  return { me, call };
}

export const start = app.mutation({
  access: "recording.write",
  args: { code: s.string({ maxLength: 64 }) },
  returns: s.object({ startedAt: s.number() }),
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { code }) => {
    const meeting = await meetingFor(ctx, code);
    const { me, call } = await runningCall(ctx, meeting);
    if (call.recording && call.recording.stoppedAt === undefined) return { startedAt: call.recording.startedAt };
    const now = Date.now();
    await ctx.db.patch(calls, call.id, { recording: { by: me.id, byName: nameOf(me), startedAt: now } });
    await append(ctx, meeting, { callId: call.id, kind: "system", text: `${nameOf(me)} started recording this call. By staying in it you agree to be recorded.` });
    return { startedAt: now };
  },
});

export const stop = app.mutation({
  access: "recording.write",
  args: { code: s.string({ maxLength: 64 }) },
  returns: s.object({ ok: s.boolean() }),
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { code }) => {
    const meeting = await meetingFor(ctx, code);
    const { me, call } = await runningCall(ctx, meeting);
    if (!call.recording || call.recording.stoppedAt !== undefined) return { ok: true };
    await ctx.db.patch(calls, call.id, { recording: { ...call.recording, stoppedAt: Date.now() } });
    await append(ctx, meeting, { callId: call.id, kind: "system", text: `${nameOf(me)} stopped recording` });
    return { ok: true };
  },
});
