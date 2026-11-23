/**
 * What a person asks the model to do, as themselves: a written recap of a call, and answers in the meeting. The
 * model is the environment's (Studio → Models, or a Resolver reference); every generation is durable FeltKit
 * evidence on a task. The model returns data, never tool calls: what it says is stored through the same
 * functions, and the same checks, as anything a person types.
 */
import { fail, s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { api } from "./_generated/api.js";
import { askMessages, keywords, parseRecap, recapMessages } from "./_ai.js";

async function ready(ctx: any) {
  const status = await ctx.model.status();
  if (!status.ready) fail("FAILED_PRECONDITION", `No model is configured: ${status.problems[0]?.message ?? "choose one in Studio → Models."}`, { fix: status.problems[0]?.fix });
  return status as { provider: string; model: string };
}

const toLines = (entries: Array<{ createdAt: number; authorName: string; kind: string; text: string }>) => entries.map((e) => ({ at: e.createdAt, who: e.authorName, kind: e.kind, text: e.text }));

/** A written summary, the decisions and the action items of a call, from its timeline. Replaces nothing: it is another version. */
export const recap = app.action({
  access: "ai.use",
  args: { code: s.string({ maxLength: 64 }), callNumber: s.optional(s.integer({ minimum: 1 })) },
  handler: async (ctx, { code, callNumber }) => {
    const status = await ready(ctx);
    const recapView = await ctx.runQuery(api.meetings.recap, { code, ...(callNumber ? { callNumber } : {}) });
    const { messages, truncated } = recapMessages(recapView.meeting.title, recapView.attendance.map((a: any) => a.name), toLines(recapView.entries));
    const { taskId } = await ctx.agent.openTask({ key: `recap:${recapView.call.id}:${ctx.requestId}`, objective: `Recap call ${recapView.call.number} of ${recapView.meeting.title}` });
    const g = await ctx.model.generate({ taskId, messages, stream: false, maxTokens: 1500, temperature: 0.2 });
    const parsed = parseRecap(g.text);
    if (!parsed) fail("UNAVAILABLE", "The model's answer was not a recap. Try again.", { taskId });
    const saved = await ctx.runMutation(api.summaries.saveGenerated, {
      code,
      callNumber: recapView.call.number,
      summary: parsed.summary,
      decisions: parsed.decisions,
      actions: parsed.actions,
      model: `${status.provider}/${status.model}`,
      taskId,
    });
    return { ...saved, truncated, taskId };
  },
});

/** A question answered by the assistant in the meeting, from this call and (when asked) earlier meetings. */
export const ask = app.action({
  access: "ai.use",
  args: { code: s.string({ maxLength: 64 }), question: s.string({ minLength: 2, maxLength: 500 }), history: s.optional(s.boolean()) },
  handler: async (ctx, { code, question, history }) => {
    await ready(ctx);
    const feed = await ctx.runQuery(api.meetings.feed, { code, limit: 200 });
    const meeting = await ctx.runQuery(api.meetings.get, { code });
    const past: string[] = [];
    if (history) {
      const query = keywords(question);
      const found = query.length > 1 ? await ctx.runQuery(api.search.find, { query, limit: 8, any: true }) : { hits: [] };
      for (const h of found.hits) past.push(`- (${h.kind}, "${h.title}"${h.callNumber ? ` call ${h.callNumber}` : ""}, ${new Date(h.at).toISOString().slice(0, 10)}) ${h.text}`);
    }
    const { taskId } = await ctx.agent.openTask({ key: `ask:${meeting.meeting.id}:${ctx.requestId}`, objective: question });
    const g = await ctx.model.generate({ taskId, messages: askMessages(question, meeting.meeting.title, toLines(feed.entries), past), stream: false, maxTokens: 500, temperature: 0.3 });
    const answer = g.text.trim();
    if (!answer) fail("UNAVAILABLE", "The model gave no answer. Try again.", { taskId });
    await ctx.runMutation(api.assistant.say, { code, question, answer: answer.slice(0, 3000) });
    return { taskId, answered: true };
  },
});
