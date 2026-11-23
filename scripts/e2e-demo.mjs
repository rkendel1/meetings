// Demo mode against a PRODUCTION build (`FELTKIT_DASHBOARD=1 npx feltkit start`), over HTTP: a visitor becomes a
// persona with no sign-in screen, can start a meeting, and Studio opens with no key as a read-only viewer, while the
// application's own API gives that "operator" nothing.
//   node scripts/e2e-demo.mjs [url]
import assert from "node:assert/strict";
const URL_ = process.argv[2] ?? "http://localhost:3000";
const json = { "content-type": "application/json" };

async function persona(id, name) {
  const c = { email: `${id}@demo.example`, password: `demo-${id}-meetings` };
  const post = (path, body) => fetch(`${URL_}${path}`, { method: "POST", headers: { ...json, "X-FeltKit-Session": "cookie" }, body: JSON.stringify(body) });
  let res = await post("/api/auth/signin", c);
  if (!res.ok) {
    res = await post("/api/auth/signup", { ...c, name });
    if (!res.ok) res = await post("/api/auth/signin", c);
  }
  assert.ok(res.ok, `${id} signed in (${res.status})`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const { csrf, principal } = await res.json();
  const call = async (kind, fn, args = {}) => {
    const r = await fetch(`${URL_}/api/${kind}/${encodeURIComponent(fn)}`, { method: "POST", headers: { ...json, "X-FeltKit-Session": "cookie", cookie, "X-FeltKit-CSRF": csrf }, body: JSON.stringify({ args }) });
    const body = await r.json();
    if (!body.ok) throw Object.assign(new Error(body.error?.message), { code: body.error?.code });
    return body.value;
  };
  return { principal, call };
}

// The first visitor creates the persona, the next one just signs in: both end up as the same person.
const first = await persona("ada", "Ada Lovelace");
const again = await persona("ada", "Ada Lovelace");
assert.equal(first.principal.id, again.principal.id);
assert.equal(first.principal.displayName, "Ada Lovelace");
assert.deepEqual(first.principal.roles, ["member"], "personas are ordinary members, never admins");
console.log("✓ persona: created on first use, signed in after, a plain member");

const grace = await persona("grace", "Grace Hopper");
const m = await first.call("mutation", "meetings:create", { title: "Demo call" });
const joined = await first.call("mutation", "calls:join", { code: m.code });
assert.equal(joined.started, true);
await grace.call("mutation", "calls:join", { code: m.code });
console.log("✓ a visitor starts a meeting and a second persona joins it");
await assert.rejects(first.call("mutation", "settings:save", { name: "Hijacked" }), (e) => e.code === "FORBIDDEN");
await assert.rejects(first.call("mutation", "maintenance:sweep", {}), (e) => e.code === "FORBIDDEN");
console.log("✓ personas cannot rebrand or run housekeeping");

// Studio: open, read-only.
const operator = await (await fetch(`${URL_}/_feltkit/api/operator/session`)).json();
assert.equal(operator.operator?.id, "demo-studio");
assert.deepEqual(operator.permissions, ["feltkit.operations.read"]);
assert.equal((await fetch(`${URL_}/_feltkit/api/overview`)).status, 200);
assert.equal((await fetch(`${URL_}/_feltkit/api/activity`)).status, 200);
for (const [path, method] of [["/_feltkit/api/services/jobs", "POST"], ["/_feltkit/api/models", "POST"], ["/_feltkit/api/data/meetings", "POST"], ["/_feltkit/api/run", "POST"]]) {
  const r = await fetch(`${URL_}${path}`, { method, headers: { ...json, origin: URL_ }, body: "{}" });
  assert.ok(r.status >= 400, `${method} ${path} is refused (${r.status})`);
}
console.log("✓ Studio opens with no key, can read, and every write is refused");

// The "operator" is not a user of the application.
const anon = await (await fetch(`${URL_}/api/session`)).json();
assert.equal(anon.principal, null, "the demo viewer does not leak into the application's own API");
const brand = await (await fetch(`${URL_}/api/query/settings:brand`, { method: "POST", headers: json, body: "{}" })).json();
assert.equal(brand.ok, true);
const asViewer = await fetch(`${URL_}/api/query/meetings:list`, { method: "POST", headers: json, body: "{}" });
assert.equal((await asViewer.json()).ok, false, "meetings need a real sign-in");
console.log("✓ the application's API still needs a real session");
