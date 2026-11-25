/**
 * Registering the organization's agents is for administrators only (the Agents panel form calls orgagents.register and
 * orgagents.setStatus; the server, not the form, enforces who may), and the connect grant is a secret no query returns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api";
import { canManageAgents, emptyRegistration, registrationArgs, registrationProblem, whoRegistered } from "../src/agent-admin";

const code = (e: any) => e?.code;
const GRANT = "grant_SECRET_0123456789";
const agentSession = { id: "eve", type: "agent" as const, displayName: "Eve", roles: ["agent"] };

test("only an administrator registers or suspends an agent: members, hosts and agents are refused", async () => {
  const t = await createTestApp();
  try {
    // grace is a member and the host of this meeting: hosting grants no authority over the organization's agents.
    const m = await t.as("grace").mutation(api.meetings.create, { title: "Host's meeting", access: "invited", invited: ["grace", "rogue"] });
    await assert.rejects(t.as("grace").mutation(api.orgagents.register, { principalId: "rogue", name: "Rogue", connector: "eve", connectorGrant: GRANT }), (e: any) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as(agentSession).mutation(api.orgagents.register, { principalId: "eve", name: "Eve" }), (e: any) => code(e) === "FORBIDDEN");
    assert.deepEqual(await t.as("ada").query(api.orgagents.list, {}), [], "nothing was registered by the refused calls");

    // A host cannot add an agent the organization has not registered, so adding is no way around registration.
    await assert.rejects(t.as("grace").action(api.orgagents.add, { code: m.code, principalId: "rogue" }), (e: any) => code(e) === "FAILED_PRECONDITION");
    assert.deepEqual((await t.as("grace").query(api.orgagents.forMeeting, { code: m.code })), []);

    await t.as("ada").mutation(api.orgagents.register, { principalId: "eve", name: "Eve" });
    await assert.rejects(t.as("grace").mutation(api.orgagents.setStatus, { principalId: "eve", status: "disabled" }), (e: any) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as(agentSession).mutation(api.orgagents.setStatus, { principalId: "eve", status: "disabled" }), (e: any) => code(e) === "FORBIDDEN");
    assert.equal((await t.as("grace").query(api.orgagents.list, {}))[0]?.status, "active", "a refused suspension changed nothing");
  } finally {
    await t.close();
  }
});

test("an administrator registers an agent with every field, then suspends and reactivates it", async () => {
  const t = await createTestApp();
  try {
    const saved = await t.as("ada").mutation(api.orgagents.register, { principalId: "eve", name: "Eve", purpose: "Engineering teammate", operatedBy: "Platform team", connector: "eve", connectorGrant: GRANT });
    assert.deepEqual({ id: saved.principalId, name: saved.name, purpose: saved.purpose, operatedBy: saved.operatedBy, connector: saved.connector, status: saved.status, by: saved.registeredByName }, { id: "eve", name: "Eve", purpose: "Engineering teammate", operatedBy: "Platform team", connector: "eve", status: "active", by: "Ada Lovelace" });
    assert.equal((await t.as("ada").mutation(api.orgagents.setStatus, { principalId: "eve", status: "disabled" })).status, "disabled");
    assert.deepEqual((await t.as("grace").query(api.orgagents.list, {})).map((a: any) => a.status), ["disabled"], "members see that it is suspended");
    assert.equal((await t.as("ada").mutation(api.orgagents.setStatus, { principalId: "eve", status: "active" })).status, "active");
  } finally {
    await t.close();
  }
});

test("the connect grant is never returned: not by register, the list, or the meeting's Agents panel", async () => {
  const t = await createTestApp();
  try {
    const saved = await t.as("ada").mutation(api.orgagents.register, { principalId: "eve", name: "Eve", connector: "eve", connectorGrant: GRANT });
    const m = await t.as("grace").mutation(api.meetings.create, { title: "Weekly", access: "invited", invited: ["grace"] });
    const seen = JSON.stringify([
      saved,
      await t.as("ada").mutation(api.orgagents.setStatus, { principalId: "eve", status: "disabled" }),
      await t.as("ada").query(api.orgagents.list, {}),
      await t.as("grace").query(api.orgagents.list, {}),
      await t.as("grace").query(api.orgagents.forMeeting, { code: m.code }),
    ]);
    assert.ok(!seen.includes(GRANT), "no result carries the grant");
    assert.ok(!/connectorGrant/.test(seen), "nor a field for it");
  } finally {
    await t.close();
  }
});

test("the form is offered only to holders of agents.manage; its grant field is masked and nothing logs", () => {
  assert.equal(canManageAgents(["agents.*", "settings.*"]), true, "the admin role");
  assert.equal(canManageAgents(["agents.manage"]), true);
  assert.equal(canManageAgents(["meetings.*", "agents.read", "agents.add"]), false, "the member role: hosting and adding are not registering");
  assert.equal(canManageAgents(["agents.read"]), false);
  assert.equal(canManageAgents([]), false);
  assert.equal(canManageAgents(undefined), false);

  const source = readFileSync(join(import.meta.dirname, "..", "src", "AgentRegistry.tsx"), "utf8");
  assert.match(source, /type="password" name="connect-grant"/, "the grant is typed into a masked field");
  assert.doesNotMatch(source, /console\./, "nothing in the form logs");
});

test("what the form sends: empty fields are left out, the grant is passed as typed and only when typed", () => {
  const base = { ...emptyRegistration, principalId: " eve ", name: " Eve ", purpose: "  ", operatedBy: " Platform team " };
  assert.deepEqual(registrationArgs({ ...base, connectorGrant: GRANT }), { principalId: "eve", name: "Eve", operatedBy: "Platform team", connector: "eve", connectorGrant: GRANT });
  assert.deepEqual(registrationArgs({ ...base, connectorGrant: "" }), { principalId: "eve", name: "Eve", operatedBy: "Platform team", connector: "eve" }, "blank keeps the recorded grant");
  assert.deepEqual(registrationArgs({ ...base, connector: "" }), { principalId: "eve", name: "Eve", operatedBy: "Platform team" });

  assert.match(registrationProblem({ ...base, connectorGrant: "" }, false) ?? "", /connect grant/, "a new Eve agent needs its grant");
  assert.equal(registrationProblem({ ...base, connectorGrant: "" }, true), null, "an existing one keeps its grant");
  assert.equal(registrationProblem({ ...base, connector: "" }, false), null);
  assert.match(registrationProblem({ ...base, principalId: " " }, true) ?? "", /principal id/);
  assert.match(registrationProblem({ ...base, name: "" }, true) ?? "", /name/);
});

test("people who cannot register are told who did", () => {
  assert.deepEqual(whoRegistered([{ registeredByName: "Ada Lovelace" }, { registeredByName: "Ada Lovelace" }, { registeredByName: "Alan Turing" }]), ["Ada Lovelace", "Alan Turing"]);
  assert.deepEqual(whoRegistered([]), []);
});
