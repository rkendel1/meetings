/**
 * TURN credentials (feltkit/media.ts): issued through the `turn` integration, whose provider token is
 * in FeltKit's credential custody, and only to a person with a live connection in a call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api";
import { registerAgents } from "./_org";

const claude = { id: "claude", type: "agent" as const, displayName: "Claude", roles: ["agent"] };
const code = (e: any) => e?.code;

/** A stand-in TURN provider API that records what it was asked. */
async function provider(): Promise<{ server: Server; url: string; calls: Array<{ auth: string; body: any; path: string }> }> {
  const calls: Array<{ auth: string; body: any; path: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      calls.push({ auth: String(req.headers.authorization ?? ""), body: JSON.parse(body || "{}"), path: String(req.url) });
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ iceServers: [{ urls: ["turn:turn.example:3478?transport=udp"], username: "123:key", credential: "c2VjcmV0" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}/v1/turn/keys/k1`, calls };
}

test("a person in a live call gets short-lived relay credentials; the provider token never reaches them", async () => {
  const p = await provider();
  process.env.TURN_API_URL = p.url;
  process.env.FELTKIT_CREDENTIAL_TURN = "provider-token-123";
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "Relay" });
    const a = await t.as("ada").mutation(api.calls.join, { code: m.code });
    const out: any = await t.as("ada").action(api.media.iceServers, { peerId: a.peerId });
    assert.equal(out.relay, true);
    assert.ok(out.iceServers.some((s: any) => String(s.urls).includes("turn:turn.example")));
    assert.ok(out.expiresAt > Date.now() + 3 * 3600_000);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0]!.auth, "Bearer provider-token-123");
    assert.equal(p.calls[0]!.path, "/v1/turn/keys/k1/credentials/generate-ice-servers");
    assert.deepEqual(p.calls[0]!.body, { ttl: 4 * 3600 });
    assert.ok(!JSON.stringify(out).includes("provider-token-123"));

    // Someone else's connection, no connection, an agent, and a revoked person get nothing from the provider.
    await assert.rejects(t.as("grace").action(api.media.iceServers, { peerId: a.peerId }), (e) => code(e) === "NOT_FOUND");
    await assert.rejects(t.as(claude).action(api.media.iceServers, { peerId: a.peerId }), (e) => code(e) === "FORBIDDEN");
    const m2 = await t.as("ada").mutation(api.meetings.create, { title: "Private", access: "invited", invited: ["grace"] });
    await t.as("ada").mutation(api.calls.join, { code: m2.code });
    const g = await t.as("grace").mutation(api.calls.join, { code: m2.code });
    await t.as("ada").mutation(api.meetings.update, { code: m2.code, invited: [] });
    await assert.rejects(t.as("grace").action(api.media.iceServers, { peerId: g.peerId }), (e) => ["FAILED_PRECONDITION", "NOT_FOUND"].includes(code(e)));
    assert.equal(p.calls.length, 1, "only the first, authorized request reached the provider");
  } finally {
    await t.close();
    p.server.close();
    delete process.env.TURN_API_URL;
    delete process.env.FELTKIT_CREDENTIAL_TURN;
  }
});

test("without a reachable TURN provider, a call still gets STUN (direct connections only)", async () => {
  process.env.TURN_API_URL = "http://127.0.0.1:9/v1/turn/keys/none";
  process.env.FELTKIT_CREDENTIAL_TURN = "x";
  const t = await createTestApp();
  await registerAgents(t);
  try {
    const m = await t.as("ada").mutation(api.meetings.create, { title: "No relay" });
    const a = await t.as("ada").mutation(api.calls.join, { code: m.code });
    const out: any = await t.as("ada").action(api.media.iceServers, { peerId: a.peerId });
    assert.equal(out.relay, false);
    assert.deepEqual(out.iceServers.map((s: any) => s.urls), ["stun:stun.l.google.com:19302"]);
  } finally {
    await t.close();
    delete process.env.TURN_API_URL;
    delete process.env.FELTKIT_CREDENTIAL_TURN;
  }
});
