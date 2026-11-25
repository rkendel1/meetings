/**
 * The organization's agents (app.ts `orgAgents`): which external agent identities, such as Eve, this organization owns
 * and lets attend its meetings. Administrators register, describe, disable and re-enable them; hosts invite them to
 * meetings like anyone else; participants see who they are and who operates them.
 *
 * Owning an agent is not authorizing everything it does: here it attends with the agent role, only in meetings it is
 * invited to. What it may do in other applications (a repository, a deployment) is granted there, by people.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, calls, orgAgents } from "./app.js";
import { append, endPeer, nameOf, type Call, type Meeting, type Peer } from "./_meeting.js";
import { peers } from "./_presence.js";
import { meetings } from "./app.js";

type OrgAgent = { id: string; principalId: string; name: string; purpose?: string; operatedBy?: string; status: "active" | "disabled"; registeredById: string; registeredByName: string; registeredAt: number; changedById?: string; changedAt?: number };
const AgentOut = s.object({ principalId: s.string(), name: s.string(), purpose: s.optional(s.string()), operatedBy: s.optional(s.string()), status: s.enum(["active", "disabled"] as const), registeredByName: s.string(), registeredAt: s.number(), changedAt: s.optional(s.number()) });
const out = (a: OrgAgent) => ({ principalId: a.principalId, name: a.name, ...(a.purpose ? { purpose: a.purpose } : {}), ...(a.operatedBy ? { operatedBy: a.operatedBy } : {}), status: a.status, registeredByName: a.registeredByName, registeredAt: a.registeredAt, ...(a.changedAt ? { changedAt: a.changedAt } : {}) });

/** Register (or re-describe) one of the organization's agents by its principal id: active from now on. */
export const register = app.mutation({
  access: "agents.manage",
  args: { principalId: s.string({ minLength: 1, maxLength: 120 }), name: s.string({ minLength: 1, maxLength: 60 }), purpose: s.optional(s.string({ maxLength: 300 })), operatedBy: s.optional(s.string({ maxLength: 200 })) },
  returns: AgentOut,
  handler: async (ctx, args) => {
    const me = ctx.auth.requirePrincipal();
    if (me.type !== "user") fail("FORBIDDEN", "People register the organization's agents.");
    const [existing] = (await ctx.db.find(orgAgents, { principalId: args.principalId }, { limit: 1 })) as OrgAgent[];
    const now = Date.now();
    const fields = { name: args.name.trim(), ...(args.purpose ? { purpose: args.purpose.trim() } : {}), ...(args.operatedBy ? { operatedBy: args.operatedBy.trim() } : {}) };
    if (existing) return out((await ctx.db.patch(orgAgents, existing.id, { ...fields, status: "active", changedById: me.id, changedAt: now })) as OrgAgent);
    const id = await ctx.db.insert(orgAgents, { principalId: args.principalId, ...fields, status: "active", registeredById: me.id, registeredByName: nameOf(me), registeredAt: now });
    return out((await ctx.db.get(orgAgents, id)) as OrgAgent);
  },
});

/** Disable or re-enable an agent. Disabling takes effect at once: it leaves every running call it is in. */
export const setStatus = app.mutation({
  access: "agents.manage",
  args: { principalId: s.string(), status: s.enum(["active", "disabled"] as const) },
  returns: AgentOut,
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { principalId, status }) => {
    const me = ctx.auth.requirePrincipal();
    const [agent] = (await ctx.db.find(orgAgents, { principalId }, { limit: 1 })) as OrgAgent[];
    if (!agent) fail("NOT_FOUND", "No such agent in this organization.");
    const next = (await ctx.db.patch(orgAgents, agent.id, { status, changedById: me.id, changedAt: Date.now() })) as OrgAgent;
    if (status === "disabled") {
      const now = Date.now();
      for (const p of (await ctx.db.find(peers, { principalId })) as Peer[]) {
        if (p.leftAt !== undefined) continue;
        const call = (await ctx.db.get(calls, p.callId)) as Call | null;
        const meeting = (await ctx.db.get(meetings, p.meetingId)) as Meeting | null;
        await endPeer(ctx, p, now, "removed");
        if (call && meeting && call.endedAt === undefined) await append(ctx, meeting, { callId: call.id, kind: "system", text: `${p.name} was disabled by the organization and left the call` });
      }
    }
    return out(next);
  },
});

/** The organization's agents: who they are, what they are for, who operates them, whether they may attend. */
export const list = app.query({
  access: "agents.read",
  args: {},
  returns: s.array(AgentOut),
  capability: { name: "orgagents.list", description: "The organization's agents (such as Eve): their identity, purpose, operator and whether they are active. A host invites an active one to a meeting by its principalId." },
  handler: async (ctx) => ((await ctx.db.find(orgAgents, {})) as OrgAgent[]).sort((a, b) => a.registeredAt - b.registeredAt).map(out),
});
