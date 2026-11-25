/**
 * The organization's agents (app.ts `orgAgents`): which external agent identities, such as Eve, this organization owns
 * and lets attend its meetings. Administrators register, describe, disable and re-enable them; hosts invite them to
 * meetings like anyone else; participants see who they are and who operates them.
 *
 * Owning an agent is not authorizing everything it does: here it attends with the agent role, only in meetings it is
 * invited to. What it may do in other applications (a repository, a deployment) is granted there, by people.
 */
import { fail, s } from "@feltdb/feltkit";
import { agentParticipation, app, calls, entries, orgAgents } from "./app.js";
import { append, endPeer, meetingFor, nameOf, type Call, type Meeting, type Peer } from "./_meeting.js";
import { peers } from "./_presence.js";
import { meetings } from "./app.js";

type OrgAgent = { id: string; principalId: string; name: string; purpose?: string; operatedBy?: string; status: "active" | "disabled"; connector?: "eve"; connectorGrant?: string; registeredById: string; registeredByName: string; registeredAt: number; changedById?: string; changedAt?: number };
const agentFields = { principalId: s.string(), name: s.string(), purpose: s.optional(s.string()), operatedBy: s.optional(s.string()), status: s.enum(["active", "disabled"] as const), connector: s.optional(s.enum(["eve"] as const)), registeredByName: s.string(), registeredAt: s.number(), changedAt: s.optional(s.number()) };
const AgentOut = s.object(agentFields);
const AgentHere = s.object({ ...agentFields, participation: s.optional(s.object({ status: s.enum(["invited", "started", "failed", "removed"] as const), addedByName: s.string(), addedAt: s.number(), sessionId: s.optional(s.string()), detail: s.optional(s.string()) })) });
const out = (a: OrgAgent) => ({ principalId: a.principalId, name: a.name, ...(a.purpose ? { purpose: a.purpose } : {}), ...(a.operatedBy ? { operatedBy: a.operatedBy } : {}), status: a.status, ...(a.connector ? { connector: a.connector } : {}), registeredByName: a.registeredByName, registeredAt: a.registeredAt, ...(a.changedAt ? { changedAt: a.changedAt } : {}) });

/** Register (or re-describe) one of the organization's agents by its principal id: active from now on. */
export const register = app.mutation({
  access: "agents.manage",
  args: { principalId: s.string({ minLength: 1, maxLength: 120 }), name: s.string({ minLength: 1, maxLength: 60 }), purpose: s.optional(s.string({ maxLength: 300 })), operatedBy: s.optional(s.string({ maxLength: 200 })), connector: s.optional(s.enum(["eve"] as const)), connectorGrant: s.optional(s.string({ maxLength: 120 })) },
  returns: AgentOut,
  handler: async (ctx, args) => {
    const me = ctx.auth.requirePrincipal();
    if (me.type !== "user") fail("FORBIDDEN", "People register the organization's agents.");
    const [existing] = (await ctx.db.find(orgAgents, { principalId: args.principalId }, { limit: 1 })) as OrgAgent[];
    const now = Date.now();
    const fields = { name: args.name.trim(), ...(args.purpose ? { purpose: args.purpose.trim() } : {}), ...(args.operatedBy ? { operatedBy: args.operatedBy.trim() } : {}), ...(args.connector ? { connector: args.connector } : {}), ...(args.connectorGrant ? { connectorGrant: args.connectorGrant } : {}) };
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

/** An AppPort request to the agent's application, naming the grant it issued to this Meetings. */
function appport(capability: string, grantRef: string, input: Record<string, unknown>, idempotencyKey?: string) {
  return { protocol: "appport/1", type: "request", requestId: `mtg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, capability: { name: capability, version: 1 }, invocation: { grantRef }, input, ...(idempotencyKey ? { idempotencyKey } : {}) };
}

type Participation = { id: string; meetingId: string; principalId: string; addedById: string; addedByName: string; addedAt: number; status: "invited" | "started" | "failed" | "removed"; sessionId?: string; detail?: string; removedAt?: number; notifiedSeq?: number };
const Added = s.object({ principalId: s.string(), status: s.enum(["invited", "started", "failed", "removed"] as const), sessionId: s.optional(s.string()), detail: s.optional(s.string()) });

/** The host invites an active organization agent: recorded, announced, and invited (step 1 of orgagents:add). */
export const invite = app.mutation({
  access: "agents.add",
  visibility: "internal",
  args: { code: s.string({ maxLength: 64 }), principalId: s.string() },
  returns: s.object({ meetingId: s.string(), title: s.string(), connector: s.optional(s.enum(["eve"] as const)), connectorGrant: s.optional(s.string()), name: s.string() }),
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { code, principalId }) => {
    const me = ctx.auth.requirePrincipal();
    const meeting = await meetingFor(ctx, code);
    if (meeting.hostId !== me.id) fail("FORBIDDEN", "Only the host adds agents to this meeting.");
    const [agent] = (await ctx.db.find(orgAgents, { principalId }, { limit: 1 })) as OrgAgent[];
    if (!agent || agent.status !== "active") fail("FAILED_PRECONDITION", "That agent is not one of this organization's active agents.");
    if (!meeting.invited.includes(principalId)) await ctx.db.patch(meetings, meeting.id, { invited: [...meeting.invited, principalId] });
    await ctx.db.insert(agentParticipation, { meetingId: meeting.id, principalId, addedById: me.id, addedByName: nameOf(me), addedAt: Date.now(), status: "invited" });
    await append(ctx, meeting, { kind: "system", text: `${nameOf(me)} added ${agent.name} (an agent of this organization)` });
    return { meetingId: meeting.id, title: meeting.title, ...(agent.connector ? { connector: agent.connector } : {}), ...(agent.connectorGrant ? { connectorGrant: agent.connectorGrant } : {}), name: agent.name };
  },
});

/** Records how starting the agent's execution went: started (its session), or failed and why. */
export const settle = app.mutation({
  access: "agents.add",
  visibility: "internal",
  args: { meetingId: s.string(), principalId: s.string(), status: s.enum(["invited", "started", "failed", "removed"] as const), sessionId: s.optional(s.string()), detail: s.optional(s.string({ maxLength: 500 })) },
  returns: s.null(),
  handler: async (ctx, { meetingId, principalId, status, sessionId, detail }) => {
    const rows = ((await ctx.db.find(agentParticipation, { meetingId })) as Participation[]).filter((p) => p.principalId === principalId).sort((a, b) => b.addedAt - a.addedAt);
    if (rows[0]) await ctx.db.patch(agentParticipation, rows[0].id, { status, ...(sessionId ? { sessionId } : {}), ...(detail ? { detail } : {}), ...(status === "removed" ? { removedAt: Date.now() } : {}) });
    return null;
  },
});

/**
 * Add Eve (or another organization agent) to this meeting: the host only, an active agent only. It is invited; then,
 * when the organization connected the agent's application, its execution starts there for this meeting, under the
 * organization's delegation in that application. The outcome is recorded either way; nothing here grants the agent
 * any authority beyond attending this meeting.
 */
export const add = app.action({
  access: "agents.add",
  args: { code: s.string({ maxLength: 64 }), principalId: s.string({ maxLength: 120 }) },
  returns: Added,
  handler: async (ctx, { code, principalId }) => {
    const me = ctx.auth.requirePrincipal();
    const invited: any = await ctx.runMutation({ name: "orgagents:invite" } as never, { code, principalId } as never);
    if (invited.connector !== "eve") return { principalId, status: "invited" as const, detail: `${invited.name} is invited; this organization starts it elsewhere.` };
    try {
      if (!invited.connectorGrant) throw Object.assign(new Error("The organization has not recorded the grant its Eve application issued to Meetings (connectorGrant)."), { code: "CONFIGURATION" });
      const out: any = await ctx.integrations.invoke("eve.join", appport("eve.meetings.join", invited.connectorGrant, { code, title: invited.title, requestedBy: { id: me.id, name: (me as any).displayName ?? me.id } }, `meeting:${code}:${principalId}`));
      if (!out.ok) throw Object.assign(new Error(out.error?.message ?? "The Eve application refused."), { code: out.error?.code ?? "REFUSED" });
      await ctx.runMutation({ name: "orgagents:settle" } as never, { meetingId: invited.meetingId, principalId, status: "started", sessionId: out.output.sessionId } as never);
      return { principalId, status: "started" as const, sessionId: out.output.sessionId };
    } catch (error) {
      const detail = `${(error as { code?: string }).code ?? "ERROR"}: ${String((error as Error).message ?? error).slice(0, 300)}`;
      await ctx.runMutation({ name: "orgagents:settle" } as never, { meetingId: invited.meetingId, principalId, status: "failed", detail } as never);
      return { principalId, status: "failed" as const, detail };
    }
  },
});

/** The host removes an agent from this meeting: no longer invited, out of the call, and its execution here ended. */
export const remove = app.action({
  access: "agents.add",
  args: { code: s.string({ maxLength: 64 }), principalId: s.string({ maxLength: 120 }) },
  returns: Added,
  handler: async (ctx, { code, principalId }) => {
    const out0: any = await ctx.runMutation({ name: "orgagents:uninvite" } as never, { code, principalId } as never);
    const out = out0;
    let detail: string | undefined;
    if (out0.connector === "eve") {
      try {
        const out: any = await ctx.integrations.invoke("eve.leave", appport("eve.meetings.leave", out0.connectorGrant ?? "", { code }));
        if (!out.ok) throw Object.assign(new Error(out.error?.message ?? "The Eve application refused."), { code: out.error?.code ?? "REFUSED" });
      } catch (error) {
        detail = `Its execution may still be running: ${(error as { code?: string }).code ?? "ERROR"}: ${String((error as Error).message ?? error).slice(0, 300)}`;
      }
    }
    await ctx.runMutation({ name: "orgagents:settle" } as never, { meetingId: out.meetingId, principalId, status: "removed", ...(detail ? { detail } : {}) } as never);
    return { principalId, status: "removed" as const, ...(detail ? { detail } : {}) };
  },
});

export const uninvite = app.mutation({
  access: "agents.add",
  visibility: "internal",
  args: { code: s.string({ maxLength: 64 }), principalId: s.string() },
  returns: s.object({ meetingId: s.string(), connector: s.optional(s.enum(["eve"] as const)), connectorGrant: s.optional(s.string()) }),
  retry: { sequenceConflicts: 5 },
  handler: async (ctx, { code, principalId }) => {
    const me = ctx.auth.requirePrincipal();
    const meeting = await meetingFor(ctx, code);
    if (meeting.hostId !== me.id) fail("FORBIDDEN", "Only the host removes agents from this meeting.");
    await ctx.db.patch(meetings, meeting.id, { invited: meeting.invited.filter((id) => id !== principalId) });
    const now = Date.now();
    for (const p of (await ctx.db.find(peers, { principalId })) as Peer[]) {
      if (p.meetingId !== meeting.id || p.leftAt !== undefined) continue;
      await endPeer(ctx, p, now, "removed");
    }
    const [agent] = (await ctx.db.find(orgAgents, { principalId }, { limit: 1 })) as OrgAgent[];
    await append(ctx, meeting, { kind: "system", text: `${nameOf(me)} removed ${agent?.name ?? principalId} from this meeting` });
    return { meetingId: meeting.id, ...(agent?.connector ? { connector: agent.connector } : {}), ...(agent?.connectorGrant ? { connectorGrant: agent.connectorGrant } : {}) };
  },
});

/** For the meeting's Agents panel: the organization's active agents and, for each, its participation here. */
export const forMeeting = app.query({
  access: "agents.read",
  args: { code: s.string({ maxLength: 64 }) },
  returns: s.array(AgentHere),
  handler: async (ctx, { code }) => {
    const meeting = await meetingFor(ctx, code);
    const rows = (await ctx.db.find(agentParticipation, { meetingId: meeting.id })) as Participation[];
    return ((await ctx.db.find(orgAgents, {})) as OrgAgent[]).map((a) => {
      const last = rows.filter((r) => r.principalId === a.principalId).sort((x, y) => y.addedAt - x.addedAt)[0];
      return { ...out(a), ...(last ? { participation: { status: last.status, addedByName: last.addedByName, addedAt: last.addedAt, ...(last.sessionId ? { sessionId: last.sessionId } : {}), ...(last.detail ? { detail: last.detail } : {}) } } : {}) } as any;
    });
  },
});

/**
 * After a person speaks or shows something in a meeting where an organization agent is running: queue its delivery.
 * Called from the mutations that add chat lines and observations; the agent's own entries are never echoed to it.
 */
export async function notifyAgents(ctx: any, meetingId: string): Promise<void> {
  const me = ctx.auth.requirePrincipal();
  if (me.type !== "user") return;
  for (const p of (await ctx.db.find(agentParticipation, { meetingId })) as Participation[]) {
    if (p.status === "started") await ctx.afterCommit.jobs.enqueue("agents.notify", { meetingId, principalId: p.principalId });
  }
}

const Delivery = s.object({ code: s.string(), connectorGrant: s.optional(s.string()), participationId: s.string(), entries: s.array(s.object({ seq: s.integer(), kind: s.string(), from: s.string(), fromKind: s.string(), text: s.string() })) });

export const pending = app.query({
  access: "agents.add",
  visibility: "internal",
  args: { meetingId: s.string(), principalId: s.string() },
  returns: s.nullable(Delivery),
  handler: async (ctx, { meetingId, principalId }) => {
    const meeting = (await ctx.db.get(meetings, meetingId)) as Meeting | null;
    const p = ((await ctx.db.find(agentParticipation, { meetingId })) as Participation[]).filter((r) => r.principalId === principalId && r.status === "started").sort((a, b) => b.addedAt - a.addedAt)[0];
    const [agent] = (await ctx.db.find(orgAgents, { principalId }, { limit: 1 })) as OrgAgent[];
    if (!meeting || !p || !agent || agent.status !== "active") return null;
    const page = await ctx.db.query(entries, { where: [{ field: "meetingId", eq: meetingId }, { field: "seq", gt: p.notifiedSeq ?? 0 }], orderBy: [{ field: "seq", direction: "asc" }], limit: 50 });
    const fresh = (page.records as any[]).filter((e) => (e.kind === "chat" || e.kind === "observation") && e.authorId !== principalId && e.createdAt >= p.addedAt);
    const last = (page.records as any[]).at(-1)?.seq;
    if (!fresh.length) return last ? { code: meeting.code, participationId: p.id, entries: [], ...(agent.connectorGrant ? { connectorGrant: agent.connectorGrant } : {}), lastSeq: last } as any : null;
    return { code: meeting.code, participationId: p.id, ...(agent.connectorGrant ? { connectorGrant: agent.connectorGrant } : {}), entries: fresh.map((e) => ({ seq: e.seq, kind: e.kind, from: e.authorName, fromKind: e.authorKind, text: e.text })) };
  },
});

export const delivered = app.mutation({
  access: "agents.add",
  visibility: "internal",
  args: { participationId: s.string(), seq: s.integer() },
  returns: s.null(),
  handler: async (ctx, { participationId, seq }) => {
    const p = (await ctx.db.get(agentParticipation, participationId)) as Participation | null;
    if (p && (p.notifiedSeq ?? 0) < seq) await ctx.db.patch(agentParticipation, participationId, { notifiedSeq: seq });
    return null;
  },
});

/** The agents.notify job: deliver the new entries to the agent's running session, then record how far it got. */
export const notify = app.action({
  access: "agents.add",
  args: { meetingId: s.string(), principalId: s.string() },
  returns: s.object({ delivered: s.integer() }),
  handler: async (ctx, { meetingId, principalId }) => {
    const d: any = await ctx.runQuery({ name: "orgagents:pending" } as never, { meetingId, principalId } as never);
    if (!d) return { delivered: 0 };
    if (!d.entries.length) {
      if (d.lastSeq) await ctx.runMutation({ name: "orgagents:delivered" } as never, { participationId: d.participationId, seq: d.lastSeq } as never);
      return { delivered: 0 };
    }
    if (!d.connectorGrant) return { delivered: 0 };
    const out: any = await ctx.integrations.invoke("eve.notify", appport("eve.meetings.notify", d.connectorGrant, { code: d.code, entries: d.entries }));
    if (!out.ok) throw Object.assign(new Error(out.error?.message ?? "The Eve application refused."), { code: out.error?.code ?? "REFUSED" });
    await ctx.runMutation({ name: "orgagents:delivered" } as never, { participationId: d.participationId, seq: Math.max(...d.entries.map((e: any) => e.seq)) } as never);
    return { delivered: d.entries.length };
  },
});
