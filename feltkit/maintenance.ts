/**
 * The sweep. Presence settles lazily: a call is ended by the next write that touches it, so a call whose last
 * person vanished stays "open" until something writes. One scheduled job does that write: it ends such calls
 * (which hands them to the scribe), reminds owners of action items that fall due, and applies the retention
 * policy. An admin schedules it once (docs/STARTER.md); it runs as that admin, re-authorized on every run.
 */
import { s } from "@feltdb/feltkit";
import { app, calls, meetings } from "./app.js";
import { latestCall, settle, type Call, type Meeting } from "./_meeting.js";
import { actionItems, purgeMeeting, type ActionItem } from "./_records.js";
import { current } from "./settings.js";

const DAY = 86_400_000;
const REMIND_BEFORE_MS = DAY;
/** One run does a bounded amount of work; the next run continues. */
const BATCH = 50;

export const sweep = app.mutation({
  access: "maintenance.run",
  args: {},
  returns: s.object({ settled: s.integer(), reminded: s.integer(), purged: s.integer() }),
  handler: async (ctx) => {
    const now = Date.now();
    let settled = 0;
    for (const call of ((await ctx.db.find(calls, { open: true }, { limit: BATCH })) as Call[])) {
      const meeting = (await ctx.db.get(meetings, call.meetingId)) as Meeting | null;
      if (meeting && (await settle(ctx, meeting, now)) === null) settled++;
    }

    let reminded = 0;
    for (const item of ((await ctx.db.find(actionItems, { status: "open" })) as ActionItem[])) {
      if (reminded >= BATCH) break;
      if (!item.assigneeId || !item.dueAt || item.remindedAt || item.dueAt - now > REMIND_BEFORE_MS) continue;
      const meeting = (await ctx.db.get(meetings, item.meetingId)) as Meeting | null;
      if (!meeting) continue;
      ctx.afterCommit.notifications.send({ recipient: item.assigneeId, type: "actionitem.due", title: `Due ${item.dueAt < now ? "now" : "soon"}: ${item.text.slice(0, 120)}`, data: { code: meeting.code, item: item.id }, idempotencyKey: `due:${item.id}` });
      await ctx.db.patch(actionItems, item.id, { remindedAt: now });
      reminded++;
    }

    let purged = 0;
    const days = (await current(ctx))?.retentionDays as number | undefined;
    if (days) {
      for (const meeting of (await ctx.db.find(meetings, {})) as Meeting[]) {
        if (purged >= 10) break;
        const call = await latestCall(ctx, meeting.id);
        if (call && call.endedAt === undefined) continue;
        if ((call?.endedAt ?? meeting.createdAt) < now - days * DAY) (await purgeMeeting(ctx, meeting)), purged++;
      }
    }
    return { settled, reminded, purged };
  },
});
