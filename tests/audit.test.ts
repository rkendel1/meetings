/**
 * Adversarial and lifecycle tests: authorization boundaries, revocation, concurrency, presence
 * expiry and call settlement. Time is controlled by replacing Date.now (functions run in-process).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api";
import { registerAgents } from "./_org";

const claude = { id: "claude", type: "agent" as const, displayName: "Claude", roles: ["agent"] };
const keyAgent = { id: "apikey-bot", type: "service" as const, displayName: "Bot", roles: ["agent"] };
const code = (e: any) => e?.code;

const realNow = Date.now;
function clock(start = realNow()) {
  let t = start;
  Date.now = () => t;
  return { advance: (ms: number) => (t += ms), restore: () => (Date.now = realNow) };
}

test("a non-attendee cannot silently read a live call's chat and captions", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Link meeting", agents: "open" });
    const a = await t.as("ada").mutation(api.calls.join, { code: m.code });
    await t.as("ada").mutation(api.chat.caption, { peerId: a.peerId, code: m.code, text: "secret plan" });
    // Alan has the link but is not in the call: he must join (and be seen) to follow it.
    await assert.rejects(t.as("alan").query(api.meetings.feed, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as("alan").query(api.meetings.recap, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    // Same for an agent: join first, then read.
    await assert.rejects(t.as(claude).query(api.meetings.feed, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    await t.as(claude).mutation(api.calls.join, { code: m.code });
    const feed = await t.as(claude).query(api.meetings.feed, { code: m.code });
    assert.ok(feed.entries.some((e: any) => e.text === "secret plan"));
    // After the call, its recap belongs to the host and those who attended.
    await t.as("ada").mutation(api.calls.leave, { code: m.code });
    assert.equal((await t.as(claude).query(api.meetings.recap, { code: m.code })).call.number, 1);
    await assert.rejects(t.as("alan").query(api.meetings.recap, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    const alanFeed = await t.as("alan").query(api.meetings.feed, { code: m.code });
    assert.ok(!alanFeed.entries.some((e: any) => e.text === "secret plan"));
  } finally {
    await t.close();
  }
});

test("revoking an invitation removes the person from the live call and stops their access", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "1:1", access: "invited", invited: ["grace"] });
    const a = await t.as("ada").mutation(api.calls.join, { code: m.code });
    const g = await t.as("grace").mutation(api.calls.join, { code: m.code });
    await t.as("ada").mutation(api.meetings.update, { code: m.code, invited: [] });
    await assert.rejects(t.as("grace").mutation(api.calls.heartbeat, { peerId: g.peerId }), (e) => ["FAILED_PRECONDITION", "NOT_FOUND"].includes(code(e)));
    await assert.rejects(t.as("grace").mutation(api.signals.send, { fromPeer: g.peerId, toPeer: a.peerId, kind: g.peerId < a.peerId ? "offer" : "answer", sdp: "v=0\r\nm=audio 9 x\r\n" }), (e) => ["FAILED_PRECONDITION", "NOT_FOUND"].includes(code(e)));
    await assert.rejects(t.as("grace").query(api.meetings.get, { code: m.code }), (e) => code(e) === "NOT_FOUND");
    const state = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.deepEqual(state.peers.map((p: any) => p.principalId), ["ada"]);
    // Switching a link meeting to invite-only evicts everyone not invited, agents included.
    const m2 = await t.as("ada").mutation(api.meetings.create, { title: "Open", agents: "open" });
    await t.as("ada").mutation(api.calls.join, { code: m2.code });
    await t.as("alan").mutation(api.calls.join, { code: m2.code });
    await t.as(claude).mutation(api.calls.join, { code: m2.code });
    await t.as("ada").mutation(api.meetings.update, { code: m2.code, access: "invited", invited: ["alan"] });
    const s2 = await t.as("ada").query(api.meetings.get, { code: m2.code });
    assert.deepEqual(s2.peers.map((p: any) => p.principalId), ["ada", "alan"]);
  } finally {
    await t.close();
  }
});

test("a non-person principal with the agent role is treated as an agent, never as a person", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Keys", agents: "open" });
    // An API-key or service principal cannot start a call, create meetings, or count as a person.
    await assert.rejects(t.as(keyAgent).mutation(api.calls.join, { code: m.code }), /No call is running/);
    await assert.rejects(t.as(keyAgent).mutation(api.meetings.create, { title: "x" }), (e) => code(e) === "FORBIDDEN");
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    const k = await t.as(keyAgent).mutation(api.calls.join, { code: m.code });
    const state = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.equal(state.peers.find((p: any) => p.id === k.peerId)!.kind, "agent");
  } finally {
    await t.close();
  }
});

test("agents are refused every person-only and host-only operation, on the server", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Guarded", agents: "open" });
    const a = await t.as("ada").mutation(api.calls.join, { code: m.code });
    const c = await t.as(claude).mutation(api.calls.join, { code: m.code });
    const refused: Array<[string, () => Promise<unknown>]> = [
      ["update meeting", () => t.as(claude).mutation(api.meetings.update, { code: m.code, access: "invited" })],
      ["end call", () => t.as(claude).mutation(api.calls.end, { code: m.code })],
      ["remove a person", () => t.as(claude).mutation(api.calls.end, { code: m.code, peerId: a.peerId })],
      ["caption", () => t.as(claude).mutation(api.chat.caption, { peerId: c.peerId, code: m.code, text: "fake words" })],
      ["send signaling", () => t.as(claude).mutation(api.signals.send, { fromPeer: c.peerId, toPeer: a.peerId, kind: "offer", sdp: "v=0\r\nm=audio 9 x\r\n" })],
      ["read signaling", () => t.as(claude).query(api.signals.inbox, { peerId: c.peerId })],
      ["heartbeat someone else's connection", () => t.as(claude).mutation(api.calls.heartbeat, { peerId: a.peerId })],
    ];
    for (const [what, run] of refused) await assert.rejects(run(), (e) => ["FORBIDDEN", "NOT_FOUND"].includes(code(e)), `agent was allowed to ${what}`);
    // A person cannot impersonate another person's connection either.
    await assert.rejects(t.as("grace").mutation(api.calls.heartbeat, { peerId: a.peerId }), (e) => code(e) === "NOT_FOUND");
    // leave() acts only on the caller's own connections: naming Ada's does nothing to her.
    await t.as("grace").mutation(api.calls.leave, { code: m.code, peerId: a.peerId });
    const state = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.ok(state.peers.some((p: any) => p.id === a.peerId));
  } finally {
    await t.close();
  }
});

test("names are not trusted for identity: words are attributed to the principal, never to a chosen name", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Names" });
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    // A request cannot choose the display name (the argument does not exist).
    await assert.rejects(t.as("grace").mutation(api.calls.join, { code: m.code, name: "Ada Lovelace" } as any), (e) => code(e) === "INVALID_ARGUMENT");
    const g = await t.as("grace").mutation(api.calls.join, { code: m.code });
    await t.as("grace").mutation(api.chat.caption, { peerId: g.peerId, code: m.code, text: "I approve the budget" });
    const feed = await t.as("ada").query(api.meetings.feed, { code: m.code });
    const said = feed.entries.find((e: any) => e.kind === "caption")!;
    assert.equal(said.authorId, "grace");
    assert.equal(said.authorName, "Grace Hopper");
    const state = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.equal(state.peers.find((p: any) => p.principalId === "grace")!.kind, "person"); // the badge comes from the principal type
  } finally {
    await t.close();
  }
});

test("concurrent first joins land in one call; concurrent agent joins keep one presence", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Race", agents: "open" });
    const retry = async <T>(run: () => Promise<T>) => {
      for (let i = 0; ; i++) {
        try {
          return await run();
        } catch (e: any) {
          if (!e?.retryable || i > 8) throw e;
        }
      }
    };
    const [a, g, al] = await Promise.all(["ada", "grace", "alan"].map((u) => retry(() => t.as(u).mutation(api.calls.join, { code: m.code }))));
    assert.equal(new Set([a.callId, g.callId, al.callId]).size, 1);
    const [c1, c2, c3] = await Promise.all([1, 2, 3].map(() => retry(() => t.as(claude).mutation(api.calls.join, { code: m.code }))));
    assert.equal(new Set([c1.peerId, c2.peerId, c3.peerId]).size, 1);
    const state = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.equal(state.peers.filter((p: any) => p.kind === "agent").length, 1);
  } finally {
    await t.close();
  }
});

test("concurrent chat from many writers keeps one gap-free order", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Busy", agents: "open" });
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    await t.as("grace").mutation(api.calls.join, { code: m.code });
    await t.as(claude).mutation(api.calls.join, { code: m.code });
    const writers = ["ada", "grace", claude] as const;
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => t.as(writers[i % 3] as any).mutation(api.chat.send, { code: m.code, text: `m${i}` })));
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(failed.length, 0, `failed: ${failed.map((f) => f.reason?.message).join("; ")}`);
    const feed = await t.as("ada").query(api.meetings.feed, { code: m.code, limit: 500 });
    const seqs = feed.entries.map((e: any) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1));
    assert.equal(feed.entries.filter((e: any) => e.kind === "chat").length, 30);
  } finally {
    await t.close();
  }
});

test("presence: a crashed connection expires; the call survives a refresh and ends after the grace period", async () => {
  const c = clock();
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Lifecycle", agents: "open" });
    const a1 = await t.as("ada").mutation(api.calls.join, { code: m.code });
    const g = await t.as("grace").mutation(api.calls.join, { code: m.code });
    await t.as(claude).mutation(api.calls.join, { code: m.code });

    // Grace's browser crashes: no leave, no heartbeats. Ada and the agent keep checking in.
    for (let i = 0; i < 4; i++) {
      c.advance(15_000);
      await t.as("ada").mutation(api.calls.heartbeat, { peerId: a1.peerId });
      await t.as(claude).mutation(api.calls.join, { code: m.code });
    }
    let state = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.deepEqual(state.peers.map((p: any) => p.principalId).sort(), ["ada", "claude"]);
    // Her stale connection is told it timed out (not "removed"), and her signals are cleaned up.
    await assert.rejects(t.as("grace").mutation(api.calls.heartbeat, { peerId: g.peerId }), /timed out/);

    // Ada refreshes (the only person): the old tab says goodbye without ending the call, the new tab replaces it.
    await t.as("ada").mutation(api.calls.leave, { code: m.code, peerId: a1.peerId, final: false });
    state = await t.as(claude).query(api.meetings.get, { code: m.code });
    assert.ok(state.call, "the call is still open during the grace period");
    const a2 = await t.as("ada").mutation(api.calls.join, { code: m.code, replaces: a1.peerId });
    assert.equal(a2.callId, a1.callId, "a refresh continues the same call");

    // Ada's browser then dies. The agent stays, but agents never keep a call open: after the grace period it ends.
    for (let i = 0; i < 8; i++) {
      c.advance(15_000);
      try {
        await t.as(claude).mutation(api.calls.join, { code: m.code });
      } catch (e: any) {
        assert.match(e.message, /No call is running/);
      }
    }
    state = await t.as(claude).query(api.meetings.get, { code: m.code });
    assert.equal(state.call, null);
    const recap = await t.as("ada").query(api.meetings.recap, { code: m.code });
    assert.equal(recap.live, false);
    assert.equal(recap.calls.length, 1, "the refresh did not split the call");
  } finally {
    c.restore();
    await t.close();
  }
});

test("an explicit leave by the last person ends the call at once; a joiner during someone's departure is not lost", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Handover" });
    const a = await t.as("ada").mutation(api.calls.join, { code: m.code });
    // Grace joins while Ada leaves.
    const [g] = await Promise.all([
      (async () => {
        for (let i = 0; ; i++) {
          try {
            return await t.as("grace").mutation(api.calls.join, { code: m.code });
          } catch (e: any) {
            if (!e?.retryable || i > 8) throw e;
          }
        }
      })(),
      (async () => {
        for (let i = 0; ; i++) {
          try {
            return await t.as("ada").mutation(api.calls.leave, { code: m.code, peerId: a.peerId });
          } catch (e: any) {
            if (!e?.retryable || i > 8) throw e;
          }
        }
      })(),
    ]);
    const state = await t.as("grace").query(api.meetings.get, { code: m.code });
    assert.ok(state.call, "Grace is in an open call");
    assert.equal(state.call!.id, g.callId);
    assert.deepEqual(state.peers.map((p: any) => p.principalId), ["grace"]);
    assert.deepEqual(await t.as("grace").mutation(api.calls.leave, { code: m.code, peerId: g.peerId }), { callEnded: true });
  } finally {
    await t.close();
  }
});

test("raised hands and media flags are published per connection; agents cannot claim media", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Hands", agents: "open" });
    const a = await t.as("ada").mutation(api.calls.join, { code: m.code, mic: true, cam: true });
    const c = await t.as(claude).mutation(api.calls.join, { code: m.code, mic: true, cam: true });
    await t.as("ada").mutation(api.calls.heartbeat, { peerId: a.peerId, hand: true, cam: false, screen: true });
    await t.as(claude).mutation(api.calls.heartbeat, { peerId: c.peerId, hand: true, cam: true, screen: true });
    const peers = (await t.as("ada").query(api.meetings.get, { code: m.code })).peers;
    const ada = peers.find((p: any) => p.principalId === "ada")!;
    const agent = peers.find((p: any) => p.principalId === "claude")!;
    assert.deepEqual([ada.hand, ada.mic, ada.cam, ada.screen], [true, true, false, true]);
    assert.deepEqual([agent.hand, agent.mic, agent.cam, agent.screen], [true, false, false, false]);
  } finally {
    await t.close();
  }
});
