import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api";

const claude = { id: "claude", type: "agent" as const, displayName: "Claude", roles: ["agent"] };

test("people start, share and end a call; the recap keeps attendance and the timeline", async () => {
  const t = await createTestApp();
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Standup" });
    assert.match(m.code, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);

    const a = await t.as("ada").mutation(api.calls.join, { code: m.code, cam: true, mic: true });
    assert.equal(a.started, true);
    const g = await t.as("grace").mutation(api.calls.join, { code: m.code });
    assert.equal(g.started, false);
    assert.equal(g.callId, a.callId);

    const live = await t.as("grace").query(api.meetings.get, { code: m.code });
    assert.deepEqual(live.peers.map((p: any) => p.principalId), ["ada", "grace"]);
    assert.equal(live.peers[0].cam, true);

    await t.as("grace").mutation(api.chat.send, { code: m.code, text: "hi all" });
    await t.as("grace").mutation(api.chat.caption, { peerId: g.peerId, code: m.code, text: "good morning" });
    await t.as("ada").mutation(api.chat.react, { code: m.code, emoji: "🎉" });

    // Signaling: only between connections in the same call, read only by the recipient.
    await t.as("ada").mutation(api.signals.send, { fromPeer: a.peerId, toPeer: g.peerId, kind: "offer", sdp: "v=0" });
    await assert.rejects(t.as("grace").mutation(api.signals.send, { fromPeer: a.peerId, toPeer: g.peerId, kind: "offer", sdp: "v=0" }), /not your connection/);
    const inbox = await t.as("grace").query(api.signals.inbox, { peerId: g.peerId });
    assert.equal(inbox.length, 1);
    assert.deepEqual(await t.as("ada").query(api.signals.inbox, { peerId: g.peerId }), []);
    await t.as("grace").mutation(api.signals.ack, { peerId: g.peerId, ids: [inbox[0].id] });
    assert.equal((await t.as("grace").query(api.signals.inbox, { peerId: g.peerId })).length, 0);

    assert.deepEqual(await t.as("grace").mutation(api.calls.leave, { code: m.code, peerId: g.peerId }), { callEnded: false });
    assert.deepEqual(await t.as("ada").mutation(api.calls.leave, { code: m.code, peerId: a.peerId }), { callEnded: true });

    await t.restart(); // durable: the recap is read from FeltDB, not memory
    const recap = await t.as("ada").query(api.meetings.recap, { code: m.code });
    assert.equal(recap.call.number, 1);
    assert.ok(recap.call.endedAt);
    assert.equal(recap.live, false);
    assert.deepEqual(recap.attendance.map((x: any) => x.principalId), ["ada", "grace"]);
    assert.deepEqual(
      recap.entries.map((e: any) => `${e.kind}:${e.text}`),
      ["system:Ada Lovelace joined", "system:Grace Hopper joined", "chat:hi all", "caption:good morning", "reaction:🎉", "system:Grace Hopper left", "system:Ada Lovelace left"],
    );
    assert.deepEqual(recap.entries.map((e: any) => e.seq), [1, 2, 3, 4, 5, 6, 7]);

    // A new join starts call 2.
    const again = await t.as("grace").mutation(api.calls.join, { code: m.code });
    assert.equal(again.callNumber, 2);
  } finally {
    await t.close();
  }
});

test("an agent attends a live call, follows the timeline and leaves notes; it never keeps a call open", async () => {
  const t = await createTestApp();
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Planning" });
    await assert.rejects(t.as(claude).mutation(api.calls.join, { code: m.code }), /No call is running/);
    await assert.rejects(t.as(claude).mutation(api.meetings.create, { title: "x" }), (e: any) => e.code === "FORBIDDEN");

    const a = await t.as("ada").mutation(api.calls.join, { code: m.code });
    const c1 = await t.as(claude).mutation(api.calls.join, { code: m.code });
    const c2 = await t.as(claude).mutation(api.calls.join, { code: m.code }); // check-in, same presence
    assert.equal(c1.peerId, c2.peerId);
    const state = await t.as(claude).query(api.meetings.get, { code: m.code });
    assert.deepEqual(state.peers.map((p: any) => `${p.principalId}:${p.kind}`), ["ada:person", "claude:agent"]);

    await t.as("ada").mutation(api.chat.caption, { peerId: a.peerId, code: m.code, text: "ship on friday" });
    const feed = await t.as(claude).query(api.meetings.feed, { code: m.code, after: 0 });
    assert.ok(feed.entries.some((e: any) => e.kind === "caption" && e.text === "ship on friday"));
    const later = await t.as(claude).query(api.meetings.feed, { code: m.code, after: feed.next });
    assert.equal(later.entries.length, 0);

    await t.as(claude).mutation(api.chat.send, { code: m.code, text: "Noted." });
    await t.as(claude).mutation(api.chat.note, { code: m.code, text: "Action: ship on Friday (Ada)" });
    // Agents cannot caption, signal, or host.
    await assert.rejects(t.as(claude).mutation(api.chat.caption, { peerId: c1.peerId, code: m.code, text: "x" }), (e: any) => e.code === "FORBIDDEN");
    await assert.rejects(t.as(claude).mutation(api.signals.send, { fromPeer: c1.peerId, toPeer: a.peerId, kind: "offer", sdp: "x" }), (e: any) => e.code === "FORBIDDEN");
    await assert.rejects(t.as(claude).mutation(api.calls.end, { code: m.code }), (e: any) => e.code === "FORBIDDEN");

    // The last person leaves: the call ends although the agent is still attending.
    assert.deepEqual(await t.as("ada").mutation(api.calls.leave, { code: m.code }), { callEnded: true });
    const recap = await t.as(claude).query(api.meetings.recap, { code: m.code });
    assert.equal(recap.live, false);
    assert.deepEqual(recap.attendance.map((x: any) => `${x.principalId}:${x.kind}`), ["ada:person", "claude:agent"]);
    assert.ok(recap.entries.some((e: any) => e.kind === "note" && e.authorKind === "agent"));
  } finally {
    await t.close();
  }
});

test("invited meetings admit only the host and invitees, people or agents", async () => {
  const t = await createTestApp();
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "1:1", access: "invited", invited: ["grace"] });
    await assert.rejects(t.as("alan").query(api.meetings.get, { code: m.code }), (e: any) => e.code === "NOT_FOUND");
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    await t.as("grace").mutation(api.calls.join, { code: m.code });
    await assert.rejects(t.as(claude).mutation(api.calls.join, { code: m.code }), (e: any) => e.code === "NOT_FOUND");
    await assert.rejects(t.as("grace").mutation(api.meetings.update, { code: m.code, invited: ["alan"] }), (e: any) => e.code === "FORBIDDEN");
    await t.as("ada").mutation(api.meetings.update, { code: m.code, invited: ["grace", "claude"] });
    assert.equal((await t.as(claude).mutation(api.calls.join, { code: m.code })).callNumber, 1);
    assert.deepEqual((await t.as("grace").query(api.meetings.list)).map((x: any) => x.title), ["1:1"]);
    assert.deepEqual(await t.as("alan").query(api.meetings.list), []);
  } finally {
    await t.close();
  }
});

test("the host removes a connection or ends the call for everyone", async () => {
  const t = await createTestApp();
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Review" });
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    const g = await t.as("grace").mutation(api.calls.join, { code: m.code });
    await t.as("ada").mutation(api.calls.end, { code: m.code, peerId: g.peerId });
    await assert.rejects(t.as("grace").mutation(api.calls.heartbeat, { peerId: g.peerId }), /no longer in this call/);
    await t.as("ada").mutation(api.calls.end, { code: m.code });
    const state = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.equal(state.call, null);
    assert.equal(state.peers.length, 0);
  } finally {
    await t.close();
  }
});
