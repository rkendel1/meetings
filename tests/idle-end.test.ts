/**
 * A call nobody uses ends by itself (after a "Still here?" prompt), and a meeting can be ended and closed by hand.
 * Time is controlled by replacing Date.now (functions run in-process). Presence expires after 45 s without a
 * check-in, so the tests check in every 15 s, as each browser tab does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api";
import { registerAgents } from "./_org";

const claude = { id: "claude", type: "agent" as const, displayName: "Claude", roles: ["agent"] };
const code = (e: any) => e?.code;
const MIN = 60_000;
const realNow = Date.now;
function clock(start = realNow()) {
  let t = start;
  Date.now = () => t;
  return { advance: (ms: number) => (t += ms), now: () => t, restore: () => (Date.now = realNow) };
}

async function drain(t: any, wait?: () => void) {
  for (let i = 0; i < 100; i++) {
    await t.runtime.runServices();
    const all = await t.runtime.listOutbox();
    const failed = all.find((r: any) => r.state === "failed");
    if (failed) throw new Error(`an after-commit effect failed: ${failed.effect.service}.${failed.effect.method}: ${failed.error?.message}`);
    if (!all.some((r: any) => r.state === "pending" || r.state === "performing")) return;
    wait?.();
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the outbox did not drain");
}

type Who = { user: any; peerId: string };

/** Everyone's browser checks in every 15 s until `until`; a refused check-in (the call ended) is ignored. `extra` runs at each step. */
async function stay(t: any, c: ReturnType<typeof clock>, who: Who[], until: number, extra?: () => Promise<void>) {
  while (c.now() < until) {
    c.advance(Math.min(15_000, until - c.now()));
    for (const w of who) await t.as(w.user).mutation(api.calls.heartbeat, { peerId: w.peerId }).catch(() => undefined);
    await extra?.();
  }
}

async function room(t: any, host = "ada", others: string[] = ["grace"]) {
  const m = await t.as(host).mutation(api.meetings.create, { title: "Planning" });
  const who: Who[] = [];
  for (const user of [host, ...others]) who.push({ user, peerId: (await t.as(user).mutation(api.calls.join, { code: m.code })).peerId });
  return { m, who };
}

const callOf = async (t: any, m: any) => (await t.as("ada").query(api.meetings.get, { code: m.code })).call;
const recapOf = (t: any, m: any, as = "ada") => t.as(as).query(api.meetings.recap, { code: m.code });

test("a call nobody uses asks \"Still here?\" after 15 minutes and ends 2 minutes later, recap and all", async () => {
  const c = clock();
  const t = await createTestApp();
  try {
    const { m, who } = await room(t);
    const t0 = c.now();
    await t.as("ada").mutation(api.chat.send, { code: m.code, text: "decision: ship on Friday" });
    await stay(t, c, who, t0 + 14 * MIN + 45_000);
    assert.equal((await callOf(t, m)).idleEndsAt ?? 0, 0, "nothing is asked before 15 minutes of silence");
    await stay(t, c, who, t0 + 15 * MIN + 15_000);
    const asked = await callOf(t, m);
    assert.ok(asked.idleEndsAt > 0, "the server asks");
    assert.ok(asked.idleEndsAt - c.now() <= 2 * MIN && asked.idleEndsAt - c.now() > MIN, "for 2 minutes");
    assert.ok((await recapOf(t, m)).entries.some((e: any) => e.kind === "system" && e.text.startsWith("Still here?")), "and says so in the timeline");

    await stay(t, c, who, asked.idleEndsAt - 15_000);
    assert.ok(await callOf(t, m), "still running until the time is up");
    await stay(t, c, who, asked.idleEndsAt + 15_000);
    assert.equal(await callOf(t, m), null, "ended for everyone");
    const recap = await recapOf(t, m);
    assert.equal(recap.call.endedAt, asked.idleEndsAt, "at the time the prompt promised");
    assert.ok(recap.entries.some((e: any) => e.kind === "system" && e.text.includes("no one was active")));
    for (const w of who) await assert.rejects(t.as(w.user).mutation(api.calls.heartbeat, { peerId: w.peerId }), (e) => code(e) === "FAILED_PRECONDITION");
    await drain(t, () => c.advance(2_000));
    assert.equal((await t.as("ada").query(api.summaries.get, { code: m.code })).summary!.source, "scribe", "the recap is written");
    assert.equal((await t.as("grace").mutation(api.calls.join, { code: m.code })).callNumber, 2, "the link starts a new call: only an ended meeting is closed");
  } finally {
    c.restore();
    await t.close();
  }
});

test("the end does not depend on a browser timer: the maintenance sweep asks, and ends the call", async () => {
  const c = clock();
  const t = await createTestApp();
  try {
    const { m, who } = await room(t);
    const t0 = c.now();
    await stay(t, c, who, t0 + 14 * MIN + 50_000);
    c.advance(20_000); // past 15 minutes: nobody is writing; the check-ins are still fresh
    assert.deepEqual(await t.as("ada").mutation(api.maintenance.sweep, {}), { settled: 0, reminded: 0, purged: 0 });
    const asked = await callOf(t, m);
    assert.ok(asked.idleEndsAt > 0, "the sweep wrote the prompt");
    await stay(t, c, who, asked.idleEndsAt - 5_000);
    c.advance(10_000);
    assert.equal((await t.as("ada").mutation(api.maintenance.sweep, {})).settled, 1, "and ended the call when the time was up");
    assert.equal((await recapOf(t, m)).call.endedAt, asked.idleEndsAt);
  } finally {
    c.restore();
    await t.close();
  }
});

test("activity from a person resets the clock; answering the prompt keeps the call, too late does not", async () => {
  const c = clock();
  const t = await createTestApp();
  try {
    const { m, who } = await room(t);
    const [ada, grace] = who as [Who, Who];
    const t0 = c.now();
    // Each kind of activity, at 14 minutes, pushes the question out by 15 minutes.
    const kinds: Array<[string, () => Promise<unknown>]> = [
      ["chat", () => t.as("grace").mutation(api.chat.send, { code: m.code, text: "hello" })],
      ["a reaction", () => t.as("grace").mutation(api.chat.react, { code: m.code, emoji: "👍" })],
      ["a caption", () => t.as("grace").mutation(api.chat.caption, { peerId: grace.peerId, code: m.code, text: "we should ship" })],
      ["the mic", () => t.as("grace").mutation(api.calls.heartbeat, { peerId: grace.peerId, mic: true })],
      ["the camera", () => t.as("grace").mutation(api.calls.heartbeat, { peerId: grace.peerId, cam: true })],
      ["a screen share", () => t.as("grace").mutation(api.calls.heartbeat, { peerId: grace.peerId, screen: true })],
    ];
    let base = t0;
    for (const [name, act] of kinds) {
      await stay(t, c, who, base + 14 * MIN);
      await act();
      const at = c.now();
      await stay(t, c, who, at + 15 * MIN - 15_000);
      assert.equal((await callOf(t, m)).idleEndsAt ?? 0, 0, `${name} restarted the clock`);
      await stay(t, c, who, at + 15 * MIN + 15_000);
      assert.ok((await callOf(t, m)).idleEndsAt > 0, `and 15 minutes after ${name} the question comes`);
      // Say so, and it goes away.
      assert.deepEqual(await t.as("ada").mutation(api.calls.stillHere, { peerId: ada.peerId }), { ok: true });
      assert.equal((await callOf(t, m)).idleEndsAt ?? 0, 0, "the prompt is gone");
      base = c.now();
    }
    // The prompt runs out first: a late answer does not revive the call.
    await stay(t, c, who, base + 15 * MIN + 15_000);
    const asked = await callOf(t, m);
    assert.ok(asked.idleEndsAt > 0);
    await stay(t, c, who, asked.idleEndsAt - 5_000);
    c.advance(10_000);
    assert.deepEqual(await t.as("grace").mutation(api.calls.stillHere, { peerId: grace.peerId }), { ok: false });
    assert.equal(await callOf(t, m), null);
    assert.equal((await recapOf(t, m)).call.endedAt, asked.idleEndsAt);
  } finally {
    c.restore();
    await t.close();
  }
});

test("an agent's activity never keeps a call alive", async () => {
  const c = clock();
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Planning", invited: ["claude"] });
    const who: Who[] = [];
    for (const user of ["ada", "grace"]) who.push({ user, peerId: (await t.as(user).mutation(api.calls.join, { code: m.code })).peerId });
    await t.as(claude).mutation(api.calls.join, { code: m.code });
    const t0 = c.now();
    let n = 0;
    // The agent chats, reacts, takes notes and checks in the whole time (and keeps trying after the call has ended).
    const busy = async () => {
      const run = (p: Promise<unknown>) => p.catch(() => undefined);
      await run(t.as(claude).mutation(api.calls.join, { code: m.code }));
      await run(t.as(claude).mutation(api.chat.send, { code: m.code, text: `still working ${n++}` }));
      await run(t.as(claude).mutation(api.chat.react, { code: m.code, emoji: "👍" }));
      await run(t.as(claude).mutation(api.chat.note, { code: m.code, text: "a note" }));
    };
    await stay(t, c, who, t0 + 15 * MIN + 15_000, busy);
    const asked = await callOf(t, m);
    assert.ok(asked.idleEndsAt > 0, "people were idle, so the question comes on time");
    assert.ok(n > 50, "and the agent really was busy");
    await stay(t, c, who, asked.idleEndsAt + 15_000, busy);
    assert.equal(await callOf(t, m), null, "and the call ends on time, although the agent never stopped");
    assert.equal((await recapOf(t, m)).call.endedAt, asked.idleEndsAt);
  } finally {
    c.restore();
    await t.close();
  }
});

test("the host ends the meeting: the call ends, the link says so, the recap stays, and only the host reopens it", async () => {
  const c = clock();
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const { m, who } = await room(t);
    await t.as("ada").mutation(api.meetings.update, { code: m.code, invited: ["claude"] });
    await t.as("grace").mutation(api.chat.send, { code: m.code, text: "decision: ship on Friday" });
    // Not the host, not an administrator, not a person: refused, and nothing changes.
    await assert.rejects(t.as("grace").mutation(api.meetings.endMeeting, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as(claude).mutation(api.meetings.endMeeting, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    assert.ok(await callOf(t, m));

    assert.equal((await t.as("ada").mutation(api.meetings.endMeeting, { code: m.code })).ok, true);
    assert.equal(await callOf(t, m), null, "the call is over for everyone");
    const state = await t.as("grace").query(api.meetings.get, { code: m.code });
    assert.equal(state.meeting.closed, true);
    assert.equal(state.meeting.closedByName, "Ada Lovelace");
    const recap = await recapOf(t, m, "grace");
    assert.ok(recap.entries.some((e: any) => e.text === "decision: ship on Friday"), "its records are kept");
    assert.ok(recap.call.endedAt);
    await drain(t, () => c.advance(2_000));
    assert.ok((await t.as("ada").query(api.summaries.get, { code: m.code })).summary, "and the scribe wrote the recap");

    // The link no longer starts a call, for anyone: person, host or agent.
    for (const user of ["grace", "ada", claude]) {
      await assert.rejects(t.as(user).mutation(api.calls.join, { code: m.code }), (e: any) => code(e) === "FAILED_PRECONDITION" && /ended/.test(e.message) && /reopen/.test(e.message));
    }
    await assert.rejects(t.as(who[1]!.user).mutation(api.calls.heartbeat, { peerId: who[1]!.peerId }), (e) => code(e) === "FAILED_PRECONDITION");
    assert.equal((await t.as("ada").mutation(api.meetings.endMeeting, { code: m.code })).ok, true, "ending it again changes nothing");

    // Reopen: the host only.
    await assert.rejects(t.as("grace").mutation(api.meetings.reopen, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as(claude).mutation(api.meetings.reopen, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    assert.deepEqual(await t.as("ada").mutation(api.meetings.reopen, { code: m.code }), { ok: true });
    assert.equal((await t.as("ada").query(api.meetings.get, { code: m.code })).meeting.closed, false);
    const again = await t.as("grace").mutation(api.calls.join, { code: m.code });
    assert.equal(again.callNumber, 2, "a new call, in the same meeting");
    assert.equal((await recapOf(t, m, "grace")).calls.length, 2);
    assert.ok((await t.as("ada").query(api.meetings.recap, { code: m.code, callNumber: 1 })).entries.some((e: any) => e.text === "decision: ship on Friday"), "the first call's records are untouched");
  } finally {
    c.restore();
    await t.close();
  }
});

test("an organization admin ends the meeting when the host is gone, not while the host is in the call; another member never can", async () => {
  const c = clock();
  const t = await createTestApp();
  try {
    // Grace hosts; Alan is a member; Ada is the organization's admin and is not in the meeting.
    const { m, who } = await room(t, "grace", ["alan"]);
    const alan = who[1]!;
    await assert.rejects(t.as("alan").mutation(api.meetings.endMeeting, { code: m.code }), (e) => code(e) === "FORBIDDEN", "a member who is not the host");
    await assert.rejects(t.as("ada").mutation(api.meetings.endMeeting, { code: m.code }), (e) => code(e) === "FORBIDDEN", "the host is in the call");
    assert.ok(await callOf(t, m));

    // The host's browser dies; the others stay. Once the host is gone the admin may end it.
    await stay(t, c, [alan], c.now() + 60_000);
    await assert.rejects(t.as("alan").mutation(api.meetings.endMeeting, { code: m.code }), (e) => code(e) === "FORBIDDEN", "the host being gone does not make any member an admin");
    assert.equal((await t.as("ada").mutation(api.meetings.endMeeting, { code: m.code })).ok, true);
    assert.equal(await callOf(t, m), null);
    const state = await t.as("grace").query(api.meetings.get, { code: m.code });
    assert.equal(state.meeting.closed, true);
    assert.equal(state.meeting.closedByName, "Ada Lovelace");
    await assert.rejects(t.as("alan").mutation(api.calls.join, { code: m.code }), (e) => code(e) === "FAILED_PRECONDITION");
    // The admin does not become the host: only Grace reopens it.
    await assert.rejects(t.as("ada").mutation(api.meetings.reopen, { code: m.code }), (e) => code(e) === "FORBIDDEN");
    await t.as("grace").mutation(api.meetings.reopen, { code: m.code });
    assert.equal((await t.as("alan").mutation(api.calls.join, { code: m.code })).callNumber, 2);
  } finally {
    c.restore();
    await t.close();
  }
});

test("a meeting that is not yours is not found when you try to end it", async () => {
  const t = await createTestApp();
  try {
    const m = await t.as("grace").mutation(api.meetings.create, { title: "Private", access: "invited" });
    await assert.rejects(t.as("alan").mutation(api.meetings.endMeeting, { code: m.code }), (e) => code(e) === "NOT_FOUND");
    await assert.rejects(t.as("alan").mutation(api.meetings.endMeeting, { code: "nope-nope-nop" }), (e) => code(e) === "NOT_FOUND");
  } finally {
    await t.close();
  }
});

test("posting into a call that has ended gives a clear answer to a person and to an agent, never an internal error", async () => {
  const c = clock();
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Planning", invited: ["claude"] });
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    await t.as("grace").mutation(api.calls.join, { code: m.code });
    await t.as(claude).mutation(api.calls.join, { code: m.code });
    await t.as("ada").mutation(api.calls.end, { code: m.code });
    const outcome = async (run: () => Promise<unknown>) => run().then(() => "ok", (e: any) => `${code(e)}: ${e?.message}`);
    // Chat after the call belongs to the meeting, outside any call; a reaction is for a live call and says so.
    assert.equal(await outcome(() => t.as("ada").mutation(api.chat.send, { code: m.code, text: "after" })), "ok");
    assert.equal(await outcome(() => t.as("grace").mutation(api.chat.send, { code: m.code, text: "after" })), "ok");
    assert.equal(await outcome(() => t.as(claude).mutation(api.chat.send, { code: m.code, text: "after" })), "ok");
    assert.equal(await outcome(() => t.as(claude).mutation(api.chat.note, { code: m.code, text: "after" })), "ok");
    assert.equal(await outcome(() => t.as("ada").mutation(api.chat.react, { code: m.code, emoji: "👍" })), "FAILED_PRECONDITION: Reactions are for a live call.");
    assert.equal(await outcome(() => t.as(claude).mutation(api.chat.react, { code: m.code, emoji: "👍" })), "FAILED_PRECONDITION: Reactions are for a live call.");
  } finally {
    c.restore();
    await t.close();
  }
});
