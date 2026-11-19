# Phase 3.1 closure: platform closure, evidence and release acceptance

Date: 2026-11-18/19. Gap-by-gap states: [PHASE-3.1-GAPS.md](PHASE-3.1-GAPS.md). Network lab:
[docs/NETLAB.md](docs/NETLAB.md). Raw acceptance output: [docs/acceptance/](docs/acceptance/).

## Executive disposition: **BLOCKED** (on publication), with explicit limitations

The fixes Meetings needs are implemented, tested and pushed in FeltKit, and **verified by the application on a
local build**, but **none is in a published FeltKit package**. Against the exact published packages
(0.3.32 `latest`, 0.3.33 `pending`) Meetings works, and the two guarantees that depend on those fixes do not
hold. Release acceptance therefore cannot be granted. No local patch is presented as the platform.

What would unblock it: merge `rkendel1/feltkit` `claude/gallant-cannon-k8j6e9` (7 commits after PR #145,
`8325f33`…`ce0603f`), publish a release containing them, point Meetings at that exact version, and re-run the
acceptance commands below. Merging and publishing need the owner's authorization; neither was done here.

## Provenance

| Item | Value |
|---|---|
| Meetings commit under acceptance | `9c3b06e` (branch `claude/gallant-cannon-k8j6e9`), plus this document's commit |
| Published FeltKit tested | `@feltdb/feltkit` 0.3.32 (`latest`, integrity `sha512-t85yX5TyvDUn…`, registry match) and 0.3.33 (`pending`, `sha512-udQdX+uDVVxS…`, registry match) |
| Unpublished FeltKit tested | local builds of `rkendel1/feltkit` `7276b21` (app tests and browser suites) and `ce0603f` (measurement), packed and installed with `npm install --no-save`; their `package.json` still reads 0.3.32, so they are identified by commit and by the code they contain, never by version |
| FeltKit merged state | PR #145 (merged by the owner, 2026-11-18 23:29 UTC) holds `8b42b15` (MCP `_meta`), `34f1f7e` (measure detectors), `0426198` (proposal). Not in any published package (tarballs of 0.3.32 and 0.3.33 inspected for each change) |
| FeltKit pushed, not merged | `8325f33` test isolation, `7276b21` session-bound state, `c4d8263` MCP test strength, `9651ab3` MCP agent-tool validation, `ce0603f` measure negatives |

## Workstream findings

### 1. FeltKit test suite

- **Cause, proven per variable:** with only the ambient `FELTDB_URL` present, the 6 tests fail
  (components ×2, credential custody ×1, deploy ×2, dev production build ×1); with every other ambient variable
  and without `FELTDB_URL`, 17/17 pass. The product's refusals were correct (ambiguous `FELTDB_URL` +
  `FELTKIT_STATE_DIR`; `FELTDB_URL` without `FELTDB_TOKEN`); the tests inherited configuration they did not
  intend. Variables that affect behaviour: every name FeltKit's source reads (enumerated in
  `packages/sdk/test/isolate-env.ts`, 47 names + `FELTKIT_CREDENTIAL_*`).
- **Fix (feltkit `8325f33`):** the test runner removes exactly those variables before any test file loads
  (and vitest's setup), reports what it ignored, keeps unrelated ones (CI's `FELTDB_COMMIT`); a guard test fails
  when the source reads a deployment variable the list misses. No test skipped or weakened.
- **Clean environment run (before the fix, variables unset by hand), `0426198`:** 836 tests, 823 pass, 0 fail,
  3 skipped (pre-existing capability guards for older dependency releases), 10 todo; conformance passed.
- **Clean checkout run (fresh clone of `ce0603f`, `npm ci`, ambient `FELTDB_*` left in place):** see
  "FeltKit full suite" below.

### 2. Session-bound presence and media termination

FeltKit contract (`7276b21`, docs/AUTH.md "When a session ends"): `ctx.auth.session` (`{ ref }`, on `/api/*`,
`/appport`, `/mcp`) and `auth.onSessionEnd` (a mutation run as the session's principal with `{ session, reason }`
for `signed-out`, `revoked`, `rotated`, `expired`; the end is recorded in the transaction that removes the
session; at-least-once with bounded retries; expiry swept every 5 s). Meetings (`ba1484b`) binds each connection
to its session, refuses another session's heartbeat, and ends the session's connections in `calls:sessionEnded`.

Measured (instrumented browsers; "others" = every other participant's peer connection to them closed):

| Event | Published 0.3.32 / 0.3.33 | Local build `7276b21` |
|---|---|---|
| Host revokes access / removes | 0.25 s (also vs. a hostile client) | 0.25 s |
| Sign-out in another tab | others **not within 5 s** (Phase 3: 50.5 s); self 12.1 s | others **0.26 s**, hostile **0.26 s**; self 0.26 s |
| Session revoked from another device | others **not within 5 s** (Phase 3: 49.8 s / hostile 56.4 s); self 11.9 s | others **0.25 s**, hostile **0.26 s**; self 0.26 s |
| Session expiry (agent, 36 s TTL) | gone **54.9 s** after expiry | gone **4.7 s** after expiry |
| Forged heartbeat: none / invented token / another person's session | 401 / 401 / 404 | 401 / 401 / 404 |
| Another session of the same person heartbeats a connection | accepted | refused (`reason: "session"`) |

Regression tests: feltkit `test/session-bound-state.test.ts` (7, incl. durability across restart, bounded
retries, configuration); meetings `tests/session-bound.test.ts` (6: binding, replayed/forged heartbeat,
independent tabs, nobody ends another's connections, reconnect never revives, last person's session end ends
the call although an agent attends), `scripts/e2e-termination.mjs` (9), `scripts/e2e-session-expiry.mjs`.

**Enforcement boundary** (also in PHASE-3.1-GAPS.md, G2): the platform ends authority (presence, signaling,
reading and posting) at once and every other participant's client learns it at once; cooperating clients then
close their side (measured ~0.25 s), which leaves a hostile client nobody to send to. Media between two clients
that both ignore the platform cannot be stopped by server state in a peer-to-peer mesh; only a server in the
media path (SFU) can enforce that. Not closed on any published platform.

### 3. MCP idempotency

`_meta` is validated at FeltKit's boundary for every tool (agent tools included since `9651ab3`, after a
CodeRabbit Verify report on PR #145 was reproduced) and forwarded as idempotency key, timeout and trace to the
AppPort bridge. Real-socket tests (`test/mcp-idempotency.test.ts`, 7): replay returns the identical stored result
and runs once; key reuse with another body is `IDEMPOTENCY_KEY_REUSED`; MCP and `/appport` share one record;
malformed `_meta` is -32602 before anything runs; no key → every call runs; **keys are scoped to the caller's
session** (another principal or another session of the same person runs its own call) and a caller without the
permission is refused without seeing the stored result. Against the base `c3bef54`, tests 1–4 fail.
Release path: merge → "Publish packages" workflow (dispatch, or a `[publish` commit message) → npm.
**State: core fix merged (PR #145), follow-ups pushed, not published; the consuming app sees the gap on 0.3.32
and 0.3.33.**

### 4. Measurement

Tool: local build of `rkendel1/feltkit` `ce0603f`. Detectors: positive fixtures (`test/measure.test.ts` test 8),
negative fixtures (test 9: due dates, `expiresAt`, a display-string `lastSeenAt`, look-alike collection names, a
type reference or feature check on `RTCPeerConnection` are not flagged); `--check` fails for an unowned
platform-gap finding and passes once the file is declared or the finding acknowledged. Known limitation: the
scan is textual, so the same shape in a comment is reported.

Meetings at `ba1484b`+, with its declarations (`feltkit.measure.json`):

| Class | Files | Lines |
|---|--:|--:|
| domain (meeting logic) | 6 | 537 |
| experience (UI) | 8 | 1457 |
| infrastructure (application-owned) | 5 | 327 |
| configuration | 3 | 112 |
| tests (unit, acceptance, capacity, lab) | 17 | 1567 |
| generated | 7 | 93 |

Without declarations, `ce0603f` reports exactly the three app-built pieces (`src/rtc.ts` media transport,
`feltkit/_presence.ts` presence lease, `feltkit/signals.ts` transient relay) and fails `--check`; the genuinely
published 0.3.32 tool (installed in isolation, integrity checked) reports none of them. (An earlier attempt
through `npx -p @feltdb/feltkit@0.3.32` resolved the project's locally patched binary instead: recorded as a
provenance error, not as evidence.)

What it establishes: how the authored lines of this repository divide by ownership under declared rules, and
which app-built infrastructure the platform has no capability for. What it does not: total application size,
effort, quality, or a leverage ratio against an implementation without FeltKit.

### 5. Network lab

Reproducible from docs/NETLAB.md; each scenario runnable alone (`run.sh 4`). Re-run after the session changes,
2 runs each: full-cone direct ✅, Linux MASQUERADE none ✅ (as expected), symmetric none ✅ (as expected), symmetric
with TURN relay ✅ (video both ways), UDP-blocked TURN-over-TCP **OPEN** (reproduces without the app). One host,
emulated internet: not real-world interoperability.

### 6. Meetings acceptance

| Check | Published 0.3.32 | Published 0.3.33 | Local build `7276b21` (not a release) |
|---|---|---|---|
| Typecheck, production build, `measure --check` | pass | pass | pass |
| Backend tests | 25/29: **4 session-bound fail** | 25/29: same 4 | 29/29 |
| E2E (`e2e.mjs`) | 13/14: **MCP replay gap** | 13/14: same | 14/14 |
| Termination (`e2e-termination.mjs`, strict bounds) | 5/9: **4 session-end cases fail** | 5/9: same | 9/9 |
| Session expiry (`e2e-session-expiry.mjs`, ≤ 8 s) | **fail (54.9 s)** | not run | pass (4.7 s) |
| Identity (`e2e-identity.mjs`) | pass | pass | not re-run on `7276b21` |

Covered within those suites on every platform tested: access control and invite revocation, identity
attribution, reconnect and duplicate tabs, host controls, agent authority (cannot create or host calls, send
media or keep a call alive), non-attendees cannot read chat or captions, the last person leaving ends the call.

## Release recommendation

**Safe to claim today (published FeltKit 0.3.32, Meetings `9c3b06e`):** video calls with chat, captions,
reactions and recaps; agents as authorized MCP participants that cannot create, host or keep calls alive or
send media; meeting-level revocation enforced in ~0.25 s; signaling limits; TURN through a credential-custody
integration; correct behaviour across the emulated NAT matrix except TCP-only relay.

**Implemented but not published:** session-bound presence (`ctx.auth.session`, `auth.onSessionEnd`), MCP replay
safety and its follow-up validation fix, measure's collaboration detectors, and test isolation.

**Unproven:** calls across real, independent networks and devices; TURN over TCP with UDP blocked; capacity on
real devices (this host: 3); behaviour in Firefox and Safari.

**Before another application relies on these capabilities:** merge the remaining FeltKit commits, publish a
release that contains them, verify that release's tarball contains each change, re-run the FeltKit suite from a
clean checkout of the released commit, and re-run the Meetings acceptance against that exact version. For media
enforcement without client cooperation, an SFU is required; for interoperability claims, a real-network test.

## FeltKit full suite (clean checkout)

Command (from a fresh `git clone --depth 1 -b claude/gallant-cannon-k8j6e9` of rkendel1/feltkit at **`ce0603f`**):

```bash
npm ci && npm run build -w @feltdb/feltkit && npm run typecheck -w @feltdb/feltkit && npm test -w @feltdb/feltkit
```

Environment: Linux 6.18.44, Node 22.23.5, 4 vCPU; the machine's `FELTDB_APPLICATION_ID`, `FELTDB_ENVIRONMENT`,
`FELTDB_URL`, `FELTDB_MODE`, `FELTDB_NAMESPACE` **left set** (the suite reports ignoring the three it reads).

| | |
|---|---|
| build, typecheck | pass |
| tests | **847: 835 pass, 0 fail, 3 skipped, 9 todo**; conformance (vitest) passed; exit 0 |
| skipped (pre-existing, unchanged) | capability guards that run only against older releases of `@authboundry/local`, `@feltdb/core` and `@appport/services` than the ones installed |
| todo | the proposal's remaining contract tests (`test/presence-contract.test.ts`) |

**Workstream 1 is resolved:** no remaining failures and no exclusions beyond the three pre-existing guards.
