/**
 * Signaling limits and authorization: roles per pair, one pending signal per pair, a per-connection
 * budget (RATE_LIMITED), SDP validation, and who may send to whom.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api";

const SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const code = (e: any) => e?.code;
const realNow = Date.now;

async function pair() {
  const t = await createTestApp();
  const m = await t.as("ada").mutation(api.meetings.create, { title: "Signals" });
  const a = await t.as("ada").mutation(api.calls.join, { code: m.code });
  const g = await t.as("grace").mutation(api.calls.join, { code: m.code });
  const [lo, hi] = a.peerId < g.peerId ? [{ who: "ada", id: a.peerId }, { who: "grace", id: g.peerId }] : [{ who: "grace", id: g.peerId }, { who: "ada", id: a.peerId }];
  return { t, m, lo, hi };
}

test("roles: only the smaller connection offers and only the larger answers", async () => {
  const { t, lo, hi } = await pair();
  try {
    await t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP });
    await t.as(hi.who).mutation(api.signals.send, { fromPeer: hi.id, toPeer: lo.id, kind: "answer", sdp: SDP });
    await assert.rejects(t.as(hi.who).mutation(api.signals.send, { fromPeer: hi.id, toPeer: lo.id, kind: "offer", sdp: SDP }), (e) => code(e) === "FAILED_PRECONDITION");
    await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "answer", sdp: SDP }), (e) => code(e) === "FAILED_PRECONDITION");
    await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: lo.id, kind: "offer", sdp: SDP }), (e) => code(e) === "NOT_FOUND");
  } finally {
    await t.close();
  }
});

test("a newer offer replaces an unread one: at most one pending signal of each kind per pair", async () => {
  const { t, lo, hi } = await pair();
  try {
    for (let i = 0; i < 10; i++) await t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP + `a=n:${i}\r\n` });
    const inbox = await t.as(hi.who).query(api.signals.inbox, { peerId: hi.id });
    assert.equal(inbox.length, 1);
    assert.match(inbox[0].sdp, /a=n:9/);
  } finally {
    await t.close();
  }
});

test("a connection that signals too much is RATE_LIMITED until its window passes", async () => {
  let now = realNow();
  Date.now = () => now;
  const { t, lo, hi } = await pair();
  try {
    for (let i = 0; i < 60; i++) await t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP });
    await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP }), (e: any) => code(e) === "RATE_LIMITED" && e.details?.retryAfterMs > 0);
    // The other direction has its own budget.
    await t.as(hi.who).mutation(api.signals.send, { fromPeer: hi.id, toPeer: lo.id, kind: "answer", sdp: SDP });
    now += 30_000;
    await t.as(lo.who).mutation(api.calls.heartbeat, { peerId: lo.id }); // stay live while the clock moves
    await t.as(hi.who).mutation(api.calls.heartbeat, { peerId: hi.id });
    await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP }), (e) => code(e) === "RATE_LIMITED");
    now += 30_001;
    await t.as(lo.who).mutation(api.calls.heartbeat, { peerId: lo.id });
    await t.as(hi.who).mutation(api.calls.heartbeat, { peerId: hi.id });
    await t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP });
  } finally {
    Date.now = realNow;
    await t.close();
  }
});

test("only session descriptions of bounded size are relayed", async () => {
  const { t, lo, hi } = await pair();
  try {
    for (const sdp of ["hello", "v=0\r\nno media lines\r\n", "<script>alert(1)</script>"]) {
      await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp }), (e) => code(e) === "INVALID_ARGUMENT", sdp);
    }
    await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP + "a=x:" + "y".repeat(70_000) + "\r\n" }), (e) => ["INVALID_ARGUMENT", "VALIDATION_FAILED", "PAYLOAD_TOO_LARGE"].includes(code(e)));
    assert.equal((await t.as(hi.who).query(api.signals.inbox, { peerId: hi.id })).length, 0);
  } finally {
    await t.close();
  }
});

test("signaling authorization: no relay to agents, other calls, departed or revoked connections", async () => {
  const { t, m, lo, hi } = await pair();
  try {
    const claude = { id: "claude", type: "agent" as const, displayName: "Claude", roles: ["agent"] };
    const c = await t.as(claude).mutation(api.calls.join, { code: m.code });
    const toAgent = lo.id < c.peerId ? "offer" : "answer";
    await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: c.peerId, kind: toAgent, sdp: SDP }), (e) => code(e) === "NOT_FOUND");
    // A connection in another meeting's call.
    const other = await t.as("alan").mutation(api.meetings.create, { title: "Elsewhere" });
    const al = await t.as("alan").mutation(api.calls.join, { code: other.code });
    await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: al.peerId, kind: lo.id < al.peerId ? "offer" : "answer", sdp: SDP }), (e) => code(e) === "NOT_FOUND");
    // Reading someone else's inbox yields nothing; acknowledging their signals deletes nothing.
    await t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP });
    assert.deepEqual(await t.as(lo.who).query(api.signals.inbox, { peerId: hi.id }), []);
    const pending = await t.as(hi.who).query(api.signals.inbox, { peerId: hi.id });
    await assert.rejects(t.as(lo.who).mutation(api.signals.ack, { peerId: hi.id, ids: [pending[0].id] }), (e) => code(e) === "NOT_FOUND");
    assert.equal((await t.as(hi.who).query(api.signals.inbox, { peerId: hi.id })).length, 1);
    // After leaving, a connection can neither send nor be sent to, and its pending signals are gone.
    await t.as(hi.who).mutation(api.calls.leave, { code: m.code, peerId: hi.id });
    await assert.rejects(t.as(lo.who).mutation(api.signals.send, { fromPeer: lo.id, toPeer: hi.id, kind: "offer", sdp: SDP }), (e) => code(e) === "NOT_FOUND");
    await assert.rejects(t.as(hi.who).mutation(api.signals.send, { fromPeer: hi.id, toPeer: lo.id, kind: "answer", sdp: SDP }), (e) => code(e) === "FAILED_PRECONDITION");
    assert.deepEqual(await t.as(hi.who).query(api.signals.inbox, { peerId: hi.id }), []);
  } finally {
    await t.close();
  }
});
