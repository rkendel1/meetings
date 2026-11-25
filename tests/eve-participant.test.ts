/**
 * An external agent (Eve) as an invited meeting participant: only the meetings it is invited to, the durable record of
 * what was decided and committed to (with where each came from), and observations a person captured, delivered as the
 * original bytes with their xeet artifact. The artifact is built by the real xeet WebAssembly module (public/xeet),
 * the same one the browser runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api";
import { registerAgents } from "./_org";

const eve = { id: "eve", type: "agent" as const, displayName: "Eve", roles: ["agent"] };
const intruder = { id: "other-agent", type: "agent" as const, displayName: "Other", roles: ["agent"] };
const PNG = readFileSync(join(import.meta.dirname, "fixtures", "observation.png"));
const code = (e: any) => e?.code;

async function xeet() {
  const glue: any = await import(join(process.cwd(), "public", "xeet", "xeet_wasm.js"));
  glue.initSync({ module: readFileSync(join(process.cwd(), "public", "xeet", "xeet_wasm_bg.wasm")) });
  return glue;
}

function captureRequest(region = [10, 20, 300, 150]) {
  return JSON.stringify({
    capturedAt: "2026-11-25T18:00:00Z",
    method: "getDisplayMedia",
    context: { capturedBy: { name: "Meetings", version: "test" }, method: "getDisplayMedia", mode: "region", platform: "test", frame: region, display: { id: 0, name: "Chrome tab: Invoices", frame: [0, 0, 1280, 800], scale: 1 }, notes: ["displaySurface: browser"] },
  });
}

async function upload(t: any, url: string, bytes: Uint8Array) {
  const token = url.split("/").pop()!;
  return t.runtime.services.redeemUpload(token, async () => bytes, { name: "observation.png", contentType: "image/png" });
}

test("Eve attends only the meetings she is invited to, as an agent, and cannot host, capture or decide", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Sprint review", access: "invited", invited: ["grace", "eve"] });
    const other = await t.as("ada").mutation(api.meetings.create, { title: "Private", access: "invited", invited: ["grace"] });
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    await t.as(eve).mutation(api.calls.join, { code: m.code });
    const state = await t.as(eve).query(api.meetings.get, { code: m.code });
    assert.deepEqual(state.peers.map((p: any) => `${p.principalId}:${p.kind}`), ["ada:person", "eve:agent"]);
    await assert.rejects(t.as(eve).query(api.meetings.get, { code: other.code }), (e: any) => code(e) === "NOT_FOUND");
    await assert.rejects(t.as(intruder).mutation(api.calls.join, { code: m.code }), (e: any) => code(e) === "NOT_FOUND");
    await t.as(eve).mutation(api.chat.send, { code: m.code, text: "Hello, I'm Eve." });
    const feed = await t.as("ada").query(api.meetings.feed, { code: m.code });
    assert.ok(feed.entries.some((e: any) => e.authorId === "eve" && e.authorKind === "agent" && e.text === "Hello, I'm Eve."));
    await assert.rejects(t.as(eve).mutation(api.observations.prepare, { code: m.code }), (e: any) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as(eve).mutation(api.continuity.follows, { code: m.code, previousCode: other.code }), (e: any) => code(e) === "FORBIDDEN");
  } finally {
    await t.close();
  }
});

test("the organization owns its agents: only registered, active agents attend; disabling one removes it at once", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  const rogue = { id: "rogue", type: "agent" as const, displayName: "Rogue", roles: ["agent"] };
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Weekly", access: "invited", invited: ["eve", "rogue"] });
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    // Invited but not the organization's: refused everything, whoever invited it.
    await assert.rejects(t.as(rogue).mutation(api.calls.join, { code: m.code }), (e: any) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as(rogue).query(api.meetings.list, {}), (e: any) => code(e) === "FORBIDDEN");
    // Only an administrator registers or disables agents; members see who they are.
    await assert.rejects(t.as("grace").mutation(api.orgagents.register, { principalId: "rogue", name: "Rogue" }), (e: any) => code(e) === "FORBIDDEN");
    assert.deepEqual((await t.as("grace").query(api.orgagents.list, {})).find((a: any) => a.principalId === "eve")?.status, "active");

    await t.as(eve).mutation(api.calls.join, { code: m.code });
    await t.as("ada").mutation(api.orgagents.setStatus, { principalId: "eve", status: "disabled" });
    const live = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.deepEqual(live.peers.map((p: any) => p.principalId), ["ada"], "a disabled agent leaves the running call at once");
    await assert.rejects(t.as(eve).query(api.meetings.feed, { code: m.code }), (e: any) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as(eve).query(api.continuity.context, { code: m.code }), (e: any) => code(e) === "FORBIDDEN");
    const feed = await t.as("ada").query(api.meetings.feed, { code: m.code });
    assert.ok(feed.entries.some((e: any) => e.kind === "system" && /disabled by the organization/.test(e.text)));

    await t.as("ada").mutation(api.orgagents.setStatus, { principalId: "eve", status: "active" });
    await t.as(eve).mutation(api.calls.join, { code: m.code });
  } finally {
    await t.close();
  }
});

test("only a person decides: an agent's decision is a proposal until a person confirms it", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Planning", access: "invited", invited: ["eve"] });
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    await t.as(eve).mutation(api.calls.join, { code: m.code });
    const proposed = await t.as(eve).mutation(api.decisions.add, { code: m.code, text: "Move the release to Friday." });
    const decided = await t.as("ada").mutation(api.decisions.add, { code: m.code, text: "Freeze features on Wednesday." });
    let list = await t.as("ada").query(api.decisions.list, { code: m.code });
    assert.deepEqual(list.map((d: any) => [d.text, d.status, d.source]), [["Move the release to Friday.", "proposed", "agent"], ["Freeze features on Wednesday.", "decided", "person"]]);
    await assert.rejects(t.as(eve).mutation(api.decisions.confirm, { id: proposed.id }), (e: any) => code(e) === "FORBIDDEN");
    const confirmed = await t.as("ada").mutation(api.decisions.confirm, { id: proposed.id });
    assert.equal(confirmed.status, "decided");
    assert.equal(confirmed.decidedById, "ada");
    list = await t.as(eve).query(api.decisions.list, { code: m.code });
    assert.deepEqual(list.map((d: any) => d.status), ["decided", "decided"]);
    assert.equal(decided.created, true);
  } finally {
    await t.close();
  }
});

test("meetings.context: the previous meeting's decisions and open commitments, each with the line it came from; withheld from someone not in it", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const before = await t.as("ada").mutation(api.meetings.create, { title: "Sprint 41", access: "invited", invited: ["grace", "eve"] });
    const a = await t.as("ada").mutation(api.calls.join, { code: before.code });
    await t.as("grace").mutation(api.calls.join, { code: before.code });
    await t.as(eve).mutation(api.calls.join, { code: before.code });
    await t.as("ada").mutation(api.chat.caption, { peerId: a.peerId, code: before.code, text: "Let's fix the invoice total bug before the release." });
    await t.as("ada").mutation(api.decisions.add, { code: before.code, text: "Fix the invoice total bug before release." });
    const open = await t.as("ada").mutation(api.actions.add, { code: before.code, text: "Fix the invoice total rounding", assignee: "grace" });
    const done = await t.as("ada").mutation(api.actions.add, { code: before.code, text: "Write the release notes", assignee: "ada" });
    await t.as(eve).mutation(api.decisions.add, { code: before.code, text: "Ship release 2.0 next week." });
    await t.as("grace").mutation(api.calls.leave, { code: before.code });
    await t.as(eve).mutation(api.calls.leave, { code: before.code });
    await t.as("ada").mutation(api.calls.leave, { code: before.code });

    await t.as("ada").mutation(api.actions.update, { id: done.id, status: "done" });
    await t.as("ada").mutation(api.actions.addEvidence, { id: done.id, kind: "link", ref: "release-notes", url: "https://example.com/notes" });
    await assert.rejects(t.as("ada").mutation(api.actions.addEvidence, { id: done.id, kind: "link", ref: "x", url: "javascript:alert(1)" }), (e: any) => code(e) === "INVALID_ARGUMENT");

    const now = await t.as("ada").mutation(api.meetings.create, { title: "Sprint 42", access: "invited", invited: ["grace", "eve", "other-agent"] });
    await assert.rejects(t.as("grace").mutation(api.continuity.follows, { code: now.code, previousCode: before.code }), (e: any) => code(e) === "FORBIDDEN");
    await t.as("ada").mutation(api.continuity.follows, { code: now.code, previousCode: before.code });
    await t.as("ada").mutation(api.calls.join, { code: now.code });
    await t.as(eve).mutation(api.calls.join, { code: now.code });

    const ctx = await t.as(eve).query(api.continuity.context, { code: now.code });
    assert.equal(ctx.previous!.code, before.code);
    assert.deepEqual(ctx.previous!.decisions.map((d: any) => [d.text, d.status, d.source]), [["Fix the invoice total bug before release.", "decided", "person"], ["Ship release 2.0 next week.", "proposed", "agent"]]);
    assert.deepEqual(ctx.stillOpen.map((a: any) => [a.id, a.assignee]), [[open.id, "Grace Hopper"]]);
    assert.deepEqual(ctx.completedSincePrevious.map((a: any) => [a.id, a.evidence[0].url]), [[done.id, "https://example.com/notes"]]);

    // Someone invited to this meeting but not the earlier one does not see the earlier one's records.
    await t.as(intruder).mutation(api.calls.join, { code: now.code });
    const theirs = await t.as(intruder).query(api.continuity.context, { code: now.code });
    assert.equal(theirs.previous, null);
    assert.match(theirs.previousWithheld!, /not invited/);
    assert.deepEqual(theirs.stillOpen, []);
  } finally {
    await t.close();
  }
});

test("observations: a present person's capture, verified against the stored bytes; Eve receives the original image and its artifact", async () => {
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const x = await xeet();
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Bug triage", access: "invited", invited: ["grace", "eve"] });
    await assert.rejects(t.as("ada").mutation(api.observations.prepare, { code: m.code }), (e: any) => code(e) === "FAILED_PRECONDITION");
    await t.as("ada").mutation(api.calls.join, { code: m.code });
    await t.as(eve).mutation(api.calls.join, { code: m.code });
    await assert.rejects(t.as("grace").mutation(api.observations.prepare, { code: m.code }), (e: any) => code(e) === "FORBIDDEN", "not in the call");

    const built = JSON.parse(x.capture_screenshot(PNG, captureRequest()));
    const link = await t.as("ada").mutation(api.observations.prepare, { code: m.code });
    const file = await upload(t, link.url, PNG);
    const recorded = await t.as("ada").action(api.observations.add, { code: m.code, fileId: file.id, artifact: built.documentText, contextText: built.contextText, caption: "The invoice total is off by one cent" });
    assert.equal(recorded.created, true);
    assert.equal(recorded.sha256, `sha256:${createHash("sha256").update(PNG).digest("hex")}`);
    assert.equal(recorded.artifactId, JSON.parse(built.documentText).id);

    const feed = await t.as(eve).query(api.meetings.feed, { code: m.code });
    const entry = feed.entries.find((e: any) => e.kind === "observation");
    assert.match(entry!.text, /Ada Lovelace shared an observation \(\d+×\d+\): The invoice total is off by one cent/);

    const got = await t.as(eve).query(api.observations.get, { id: recorded.id });
    assert.deepEqual(Buffer.from(got.imageBase64, "base64"), PNG, "the original bytes, unchanged");
    assert.deepEqual(got.region, { x: 10, y: 20, w: 300, h: 150 });
    assert.equal(got.method, "getDisplayMedia");
    assert.equal(got.mode, "region");
    assert.equal(got.surface?.label, "Chrome tab: Invoices");
    assert.equal(JSON.parse(x.verify_screenshot(got.artifact, Buffer.from(got.imageBase64, "base64"), got.contextText)).ok, true, "Eve can verify it herself");
    // Grace is invited but not in the running call: like the timeline, she cannot read it until the call ends.
    await assert.rejects(t.as("grace").query(api.observations.get, { id: recorded.id }), (e: any) => code(e) === "NOT_FOUND");

    // An artifact that does not describe the uploaded bytes is refused; so is someone else's upload.
    const other = JSON.parse(x.capture_screenshot(PNG, captureRequest([0, 0, 50, 50])));
    const tampered = Buffer.from(PNG);
    tampered[tampered.length - 20] ^= 0xff;
    const link2 = await t.as("ada").mutation(api.observations.prepare, { code: m.code });
    const file2 = await upload(t, link2.url, tampered);
    await assert.rejects(t.as("ada").action(api.observations.add, { code: m.code, fileId: file2.id, artifact: other.documentText, contextText: other.contextText }), (e: any) => code(e) === "INVALID_ARGUMENT");
    await t.as("grace").mutation(api.calls.join, { code: m.code });
    await assert.rejects(t.as("grace").action(api.observations.add, { code: m.code, fileId: file.id, artifact: built.documentText, contextText: built.contextText }), (e: any) => code(e) === "FORBIDDEN");
    // A changed context no longer verifies against the artifact.
    await assert.rejects(t.as("ada").action(api.observations.add, { code: m.code, fileId: file.id, artifact: built.documentText, contextText: built.contextText.replace("region", "window") }), (e: any) => code(e) === "INVALID_ARGUMENT");

    const listed = await t.as(eve).query(api.observations.list, { code: m.code });
    assert.equal(listed.length, 1);
    const ctx = await t.as(eve).query(api.continuity.context, { code: m.code });
    assert.equal(ctx.meeting.observations[0].sha256, recorded.sha256);
  } finally {
    await t.close();
  }
});

test("Add Eve: the host adds an active organization agent; the outcome of starting its execution is recorded, never assumed", async () => {
  const t = await createTestApp();
  try {
    await t.as("ada").mutation(api.orgagents.register, { principalId: "eve", name: "Eve", purpose: "Engineering teammate", operatedBy: "Platform team", connector: "eve" });
    await t.as("ada").mutation(api.orgagents.register, { principalId: "helper", name: "Helper" });
    await t.as("ada").mutation(api.orgagents.setStatus, { principalId: "helper", status: "disabled" });
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Triage", access: "invited", invited: ["grace"] });
    await t.as("ada").mutation(api.calls.join, { code: m.code });

    await assert.rejects(t.as("grace").action(api.orgagents.add, { code: m.code, principalId: "eve" }), (e: any) => code(e) === "FORBIDDEN");
    await assert.rejects(t.as("ada").action(api.orgagents.add, { code: m.code, principalId: "helper" }), (e: any) => code(e) === "FAILED_PRECONDITION");

    // No Eve application is connected in this test: Eve is invited, and the record says her execution did not start, and why.
    const added = await t.as("ada").action(api.orgagents.add, { code: m.code, principalId: "eve" });
    assert.equal(added.status, "failed");
    assert.match(added.detail!, /[A-Z_]+: /);
    const here = await t.as("grace").query(api.orgagents.forMeeting, { code: m.code });
    const eveHere = here.find((a: any) => a.principalId === "eve")!;
    assert.equal(eveHere.participation?.status, "failed");
    assert.equal(eveHere.participation?.addedByName, "Ada Lovelace");
    const meeting = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.ok(meeting.meeting.invited.includes("eve"));
    await t.as(eve).mutation(api.calls.join, { code: m.code });
    const feed = await t.as("ada").query(api.meetings.feed, { code: m.code });
    assert.ok(feed.entries.some((e: any) => e.kind === "system" && e.text === "Ada Lovelace added Eve (an agent of this organization)"));

    // Removing her: no longer invited, out of the call.
    const removed = await t.as("ada").action(api.orgagents.remove, { code: m.code, principalId: "eve" });
    assert.equal(removed.status, "removed");
    const after = await t.as("ada").query(api.meetings.get, { code: m.code });
    assert.equal(after.meeting.invited.includes("eve"), false);
    assert.deepEqual(after.peers.map((p: any) => p.principalId), ["ada"]);
    await assert.rejects(t.as(eve).query(api.meetings.feed, { code: m.code }), (e: any) => code(e) === "NOT_FOUND");
  } finally {
    await t.close();
  }
});
