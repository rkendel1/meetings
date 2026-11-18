/**
 * Executable verification of FeltKit capabilities the meetings application does not use yet but would
 * build organizations, invitations and an inbox on: workspaces, e-mail invitations (preview, accept,
 * wrong address, single use), workspace-scoped data, member removal, and notifications.
 * The app under test is tests/fixtures/workspaces (a fixture, not the product).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTestApp } from "@feltdb/feltkit/testing";

const projectDir = fileURLToPath(new URL("./fixtures/workspaces", import.meta.url));
const person = (id: string) => ({ id, type: "user" as const, displayName: id, roles: ["base"] });
const create = { name: "rooms:create" } as any;
const list = { name: "rooms:list" } as any;
const inbox = { name: "rooms:inbox" } as any;
const code = (e: any) => e?.code;

test("workspaces, e-mail invitations, scoped data and removal behave as documented", async () => {
  const t = await createTestApp({ projectDir });
  try {
    const tenancy = t.tenancy!;
    const acme = await tenancy.create("Acme", { ...person("ada"), email: "ada@acme.test" });
    const globex = await tenancy.create("Globex", { ...person("bob"), email: "bob@globex.test" });
    assert.equal((await tenancy.membership(acme.id, "ada"))!.role, "owner");

    // Invite by e-mail; the invitation names the workspace and role; only the invited address accepts it, once.
    const adaCtx = { ...(await tenancy.context(acme.id, "ada"))!, principalId: "ada", displayName: "Ada" };
    const { token } = await tenancy.invite(adaCtx as any, { email: "grace@acme.test", role: "member" });
    const preview = await tenancy.preview(token);
    assert.deepEqual([preview.tenantName, preview.role, preview.email, preview.status], ["Acme", "member", "grace@acme.test", "open"]);
    await assert.rejects(tenancy.accept(token, { ...person("mallory"), email: "mallory@evil.test", emailVerified: true } as any));
    await assert.rejects(tenancy.accept(token, { ...person("grace"), email: "grace@acme.test", emailVerified: false } as any), "an unverified address cannot accept");
    const accepted = await tenancy.accept(token, { ...person("grace"), email: "grace@acme.test", emailVerified: true } as any);
    assert.equal(accepted.membership.role, "member");
    // Single use: accepting again as the same person is idempotent; anyone else is refused.
    assert.equal((await tenancy.accept(token, { ...person("grace"), email: "grace@acme.test", emailVerified: true } as any)).membership.principalId, "grace");
    await assert.rejects(tenancy.accept(token, { ...person("grace-second-account"), email: "grace@acme.test", emailVerified: true } as any), /already used/);

    // Data is scoped to the caller's workspace.
    await t.as(person("ada"), { tenant: acme.id }).mutation(create, { title: "Acme standup" });
    await t.as(person("grace"), { tenant: acme.id }).mutation(create, { title: "Acme retro" });
    await t.as(person("bob"), { tenant: globex.id }).mutation(create, { title: "Globex board" });
    assert.deepEqual(await t.as(person("grace"), { tenant: acme.id }).query(list), ["Acme retro", "Acme standup"]);
    assert.deepEqual(await t.as(person("bob"), { tenant: globex.id }).query(list), ["Globex board"]);
    // Not a member: no access to Acme's data, whatever the request says.
    await assert.rejects(t.as(person("bob"), { tenant: acme.id }).query(list));
    await assert.rejects(t.as(person("mallory"), { tenant: acme.id }).mutation(create, { title: "intrusion" }));

    // Removing a member takes effect on their next call.
    await tenancy.remove(adaCtx as any, "grace");
    await assert.rejects(t.as(person("grace"), { tenant: acme.id }).query(list));
    assert.equal(await tenancy.membership(acme.id, "grace"), null);
  } finally {
    await t.close();
  }
});

test("notifications: delivered after commit to the recipient only, and not when the change fails", async () => {
  const t = await createTestApp({ projectDir });
  try {
    const acme = await t.tenancy!.create("Acme", { ...person("ada"), email: "ada@acme.test" });
    const adaCtx = { ...(await t.tenancy!.context(acme.id, "ada"))!, principalId: "ada" };
    const { token } = await t.tenancy!.invite(adaCtx as any, { email: "grace@acme.test", role: "member" });
    await t.tenancy!.accept(token, { ...person("grace"), email: "grace@acme.test", emailVerified: true } as any);

    await t.as(person("ada"), { tenant: acme.id }).mutation(create, { title: "Planning", notify: "grace" });
    await assert.rejects(t.as(person("ada"), { tenant: acme.id }).mutation(create, { title: "", notify: "grace" }), "an invalid change commits nothing");
    await t.runtime.runServices();
    assert.deepEqual(await t.as(person("grace"), { tenant: acme.id }).query(inbox), ["ada invited you to Planning"]);
    assert.deepEqual(await t.as(person("ada"), { tenant: acme.id }).query(inbox), []);
  } finally {
    await t.close();
  }
});
