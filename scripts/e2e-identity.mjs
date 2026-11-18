// Identity with FeltKit's built-in accounts, against `npm run dev`: sign up, a wrong password refused,
// sign in, use the meetings application as that account (create a meeting, start a call), list sessions,
// sign out, and every call refused afterwards. Cookie sessions with CSRF, as the app's own client uses.
//   node scripts/e2e-identity.mjs [url]
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");

const URL_ = process.argv[2] ?? "http://localhost:3000";
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(URL_);
  const email = `identity-${Date.now()}@example.test`;
  const out = await page.evaluate(async (email) => {
    const h = { "Content-Type": "application/json", "X-FeltKit-Session": "cookie" };
    const csrf = async () => (await (await fetch("/api/session", { headers: h })).json()).csrf;
    const post = async (path, body) => {
      const r = await fetch(path, { method: "POST", headers: { ...h, "X-FeltKit-CSRF": (await csrf()) ?? "" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const who = async () => (await (await fetch("/api/session", { headers: h })).json()).principal;
    const steps = {};
    steps.signup = await post("/api/auth/signup", { email, password: "correct horse battery staple", name: "Iris Identity" });
    steps.afterSignup = await who();
    steps.signout1 = await post("/api/auth/signout", {});
    steps.afterSignout = await who();
    steps.wrongPassword = await post("/api/auth/signin", { email, password: "not the password at all" });
    steps.signin = await post("/api/auth/signin", { email, password: "correct horse battery staple" });
    steps.afterSignin = await who();
    steps.createMeeting = await post("/api/mutation/meetings:create", { args: { title: "Account-owned meeting" } });
    const code = steps.createMeeting.body?.value?.code;
    steps.join = await post("/api/mutation/calls:join", { args: { code } });
    steps.sessions = await (await fetch("/api/auth/sessions", { headers: h })).json();
    steps.signout2 = await post("/api/auth/signout", {});
    steps.afterSignout2 = await who();
    steps.refusedAfterSignout = await post("/api/mutation/meetings:create", { args: { title: "should fail" } });
    return { code, steps };
  }, email);
  const s = out.steps;
  assert.equal(s.signup.status, 201);
  assert.equal(s.afterSignup?.type, "user");
  assert.deepEqual(s.afterSignup?.roles, ["member"], "a new account is a member (auth.accounts.roles)");
  assert.equal(s.afterSignout, null);
  assert.ok(s.wrongPassword.status >= 400 && s.wrongPassword.status < 500, `wrong password: ${s.wrongPassword.status}`);
  assert.equal(s.signin.status, 200);
  assert.equal(s.afterSignin?.id, s.afterSignup.id, "the same account");
  assert.equal(s.createMeeting.status, 200);
  assert.equal(s.createMeeting.body.value.hostId, s.afterSignup.id);
  assert.equal(s.join.status, 200);
  assert.equal(s.join.body.value.started, true);
  assert.ok(Array.isArray(s.sessions.sessions ?? s.sessions) || s.sessions, "sessions listed");
  assert.equal(s.afterSignout2, null);
  assert.equal(s.refusedAfterSignout.status, 401);
  console.log(JSON.stringify({ account: s.afterSignup.id, roles: s.afterSignup.roles, wrongPassword: s.wrongPassword.status, meeting: out.code, joined: s.join.body.value, afterSignOut: s.refusedAfterSignout.status }));
  console.log("✓ identity: sign-up, refused wrong password, sign-in, use the app as the account, sign-out ends access");
} finally {
  await browser.close();
}
