/**
 * The sweep. Presence settles lazily: a call is ended by the next write that touches it, so a call whose last
 * person vanished stays "open" until something writes. One scheduled job does that write: it ends such calls
 * (which hands them to the scribe), reminds owners of action items that fall due, and applies the retention
 * policy. The janitor agent runs it whenever a meeting is created or a call starts (at most every 5 minutes), so
 * nothing needs scheduling; an admin can also run it here, or schedule it for reminders in a quiet system.
 */
import { s } from "@feltdb/feltkit";
import demo from "../demo.json";
import { app, calls, housekeeping, meetings } from "./app.js";
import { latestCall, settle, type Call, type Meeting } from "./_meeting.js";
import { actionItems, purgeMeeting, type ActionItem } from "./_records.js";
import { current } from "./settings.js";

const DAY = 86_400_000;
const REMIND_BEFORE_MS = DAY;
/** One run does a bounded amount of work; the next run continues. */
const BATCH = 50;

/** Do one bounded round of housekeeping. Whoever runs it: an admin (below) or the janitor agent (feltkit/agents.ts). */
export async function sweepNow(ctx: any) {
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
    const days = ((await current(ctx))?.retentionDays ?? (demo as { retentionDays?: number }).retentionDays) as number | undefined;
    if (days) {
      for (const meeting of (await ctx.db.find(meetings, {})) as Meeting[]) {
        if (purged >= 10) break;
        const call = await latestCall(ctx, meeting.id);
        if (call && call.endedAt === undefined) continue;
        if ((call?.endedAt ?? meeting.createdAt) < now - days * DAY) (await purgeMeeting(ctx, meeting)), purged++;
      }
    }
    return { settled, reminded, purged };
}

export const sweep = app.mutation({
  access: "maintenance.run",
  args: {},
  returns: s.object({ settled: s.integer(), reminded: s.integer(), purged: s.integer() }),
  handler: (ctx) => sweepNow(ctx),
});

export const SWEEP_EVERY_MS = 5 * 60_000;

/** Ask the janitor to tidy up, unless a round ran recently (so a busy system stages one a few minutes, not one per call). */
export async function kickJanitor(ctx: any) {
  const [last] = await ctx.db.find(housekeeping, { key: "sweep" }, { limit: 1 });
  if (!last || Date.now() - last.lastAt >= SWEEP_EVERY_MS) ctx.afterCommit.agent("janitor", {});
}
