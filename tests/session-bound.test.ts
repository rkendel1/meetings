/**
 * Session-bound presence: a connection belongs to the session that created it (FeltKit ctx.auth.session),
 * only that session keeps it alive, and it ends when that session ends (auth.onSessionEnd → calls:sessionEnded).
 *
 * Requires FeltKit with ctx.auth.session and auth.onSessionEnd (rkendel1/feltkit 7276b21, not yet published).
 * On a FeltKit without them these tests fail, by design: the application cannot be session-bound there.
 * Calls go through the runtime with explicit session refs, as FeltKit's HTTP, /appport and /mcp surfaces pass them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api";
import { registerAgents } from "./_org";

const ada = { id: "ada", type: "user" as const, displayName: "Ada Lovelace", roles: ["member"] };
const grace = { id: "grace", type: "user" as const, displayName: "Grace Hopper", roles: ["member"] };
const claude = { id: "claude", type: "agent" as const, displayName: "Claude", roles: ["agent"] };
const code = (e: any) => e?.code;

async function boot() {
  const t = await createTestApp();
  await registerAgents(t);
  const as = (principal: typeof ada | typeof grace | typeof claude, session: string | null) => ({
    mutation: async (fn: { name: string }, args: unknown) => unwrap(await t.runtime.call(fn.name, args, { principal, via: "test", ...(session ? { session: { ref: session } } : {}) } as any)),
    query: async (fn: { name: string }, args: unknown) => unwrap(await t.runtime.call(fn.name, args, { principal, via: "test", ...(session ? { session: { ref: session } } : {}) } as any)),
  });
  return { t, as };
}
function unwrap(r: any) {
  if (r.ok) return r.value;
  throw Object.assign(new Error(r.error.message), { code: r.error.code, details: r.error.details });
}

test("the platform provides the caller's session to the application (ctx.auth.session)", async () => {
  const { t, as } = await boot();
  try {
    const m = await as(ada, "aaaaaaaaaaaa").mutation(api.meetings.create, { title: "Probe" });
    const j = await as(ada, "aaaaaaaaaaaa").mutation(api.calls.join, { code: m.code });
    const peers = (await as(ada, "aaaaaaaaaaaa").query(api.meetings.get, { code: m.code })).peers;
    assert.equal(peers.find((p: any) => p.id === j.peerId).sessionRef, "aaaaaaaaaaaa", "the connection is bound to the session that created it");
  } finally {
    await t.close();
  }
});

test("only the creating session keeps a connection alive: another session's (replayed, forged) heartbeat is refused", async () => {
  const { t, as } = await boot();
  try {
    const m = await as(ada, "a1a1a1a1a1a1").mutation(api.meetings.create, { title: "Replay" });
    const j = await as(ada, "a1a1a1a1a1a1").mutation(api.calls.join, { code: m.code });
    await as(ada, "a1a1a1a1a1a1").mutation(api.calls.heartbeat, { peerId: j.peerId });
    // Same person, another session (another device, a stolen request replayed from elsewhere), or no session.
    await assert.rejects(as(ada, "a2a2a2a2a2a2").mutation(api.calls.heartbeat, { peerId: j.peerId }), (e: any) => code(e) === "FAILED_PRECONDITION" && e.details?.reason === "session");
    await assert.rejects(as(ada, null).mutation(api.calls.heartbeat, { peerId: j.peerId }), (e: any) => code(e) === "FAILED_PRECONDITION" && e.details?.reason === "session");
    // Nor can it send signaling from that connection.
    await assert.rejects(as(ada, "a2a2a2a2a2a2").mutation(api.signals.send, { fromPeer: j.peerId, toPeer: j.peerId, kind: "offer", sdp: "v=0\r\nm=audio 9 x\r\n" }), (e: any) => code(e) === "FAILED_PRECONDITION");
  } finally {
    await t.close();
  }
});

test("a session's end ends exactly its connections: independent tabs and other people stay", async () => {
  const { t, as } = await boot();
  try {
    const m = await as(ada, "tab1tab1tab1").mutation(api.meetings.create, { title: "Tabs" });
    const tab1 = await as(ada, "tab1tab1tab1").mutation(api.calls.join, { code: m.code });
    const tab2 = await as(ada, "tab2tab2tab2").mutation(api.calls.join, { code: m.code });
    const g = await as(grace, "gracegracegr").mutation(api.calls.join, { code: m.code });
    // What FeltKit runs (auth.onSessionEnd) when Ada's first tab signs out.
    assert.deepEqual(await as(ada, null).mutation(api.calls.sessionEnded, { session: "tab1tab1tab1", reason: "signed-out" }), { ended: 1 });
    const live = (await as(grace, "gracegracegr").query(api.meetings.get, { code: m.code })).peers.map((p: any) => p.id).sort();
    assert.deepEqual(live, [tab2.peerId, g.peerId].sort());
    await assert.rejects(as(ada, "tab1tab1tab1").mutation(api.calls.heartbeat, { peerId: tab1.peerId }), (e: any) => e.details?.reason === "session-ended");
    await as(ada, "tab2tab2tab2").mutation(api.calls.heartbeat, { peerId: tab2.peerId });
    // Running it again (the hook runs at least once) changes nothing.
    assert.deepEqual(await as(ada, null).mutation(api.calls.sessionEnded, { session: "tab1tab1tab1", reason: "signed-out" }), { ended: 0 });
  } finally {
    await t.close();
  }
});

test("nobody ends another person's session-bound connections", async () => {
  const { t, as } = await boot();
  try {
    const m = await as(ada, "adaadaadaada").mutation(api.meetings.create, { title: "Mine" });
    const a = await as(ada, "adaadaadaada").mutation(api.calls.join, { code: m.code });
    assert.deepEqual(await as(grace, null).mutation(api.calls.sessionEnded, { session: "adaadaadaada", reason: "revoked" }), { ended: 0 });
    await as(ada, "adaadaadaada").mutation(api.calls.heartbeat, { peerId: a.peerId });
  } finally {
    await t.close();
  }
});

test("reconnecting after a session ended starts a new connection; the ended one is never revived", async () => {
  const { t, as } = await boot();
  try {
    const m = await as(ada, "old0old0old0").mutation(api.meetings.create, { title: "Reconnect" });
    await as(grace, "gracegracegr").mutation(api.calls.join, { code: m.code });
    const old = await as(ada, "old0old0old0").mutation(api.calls.join, { code: m.code });
    await as(ada, null).mutation(api.calls.sessionEnded, { session: "old0old0old0", reason: "revoked" });
    // Signed in again: a new session. Even naming the old connection as the one it replaces does not revive it.
    const fresh = await as(ada, "new0new0new0").mutation(api.calls.join, { code: m.code, replaces: old.peerId });
    assert.notEqual(fresh.peerId, old.peerId);
    const peers = (await as(grace, "gracegracegr").query(api.meetings.get, { code: m.code })).peers;
    assert.deepEqual(peers.filter((p: any) => p.principalId === "ada").map((p: any) => p.id), [fresh.peerId]);
    await assert.rejects(as(ada, "new0new0new0").mutation(api.calls.heartbeat, { peerId: old.peerId }), (e: any) => code(e) === "FAILED_PRECONDITION");
  } finally {
    await t.close();
  }
});

test("when the last person's session ends, the call ends, although an agent attends", async () => {
  const { t, as } = await boot();
  try {
    const m = await as(ada, "lastlastlast").mutation(api.meetings.create, { title: "Last", agents: "open" });
    await as(ada, "lastlastlast").mutation(api.calls.join, { code: m.code });
    await as(claude, "agentagentag").mutation(api.calls.join, { code: m.code });
    await as(ada, null).mutation(api.calls.sessionEnded, { session: "lastlastlast", reason: "expired" });
    // An ended session cannot come back, so there is no grace period: the call ends now, and the agent is out.
    const state = await as(claude, "agentagentag").query(api.meetings.get, { code: m.code });
    assert.equal(state.call, null);
    assert.deepEqual(state.peers, []);
    await assert.rejects(as(claude, "agentagentag").mutation(api.calls.join, { code: m.code }), /No call is running/);
  } finally {
    await t.close();
  }
});
