# Phase 3.1 gap register

Every gap left open after Phase 3, with its disposition. States are kept separate:

- **implemented** — code exists on a branch
- **tested** — a regression test exists and passes; "fails before" means it was run against the code without the fix and failed
- **pushed** — on `origin`
- **merged** — on the repository's default branch
- **published** — in a package on npm
- **verified by consumer** — the Meetings app tested against that exact published package

Repositories: `rkendel1/meetings` and `rkendel1/feltkit`, branch `claude/gallant-cannon-k8j6e9` in both.
FeltKit on npm: `latest` = 0.3.32, `pending` = 0.3.33. Neither contains any change below (tarballs inspected
for each change's code).

| # | Gap | Severity / contract | Disposition | Fix commit | Regression test | State |
|---|---|---|---|---|---|---|
| G1 | MCP `tools/call` dropped `_meta` (idempotency key, timeout, trace): MCP replays ran twice | P1 / AppPort idempotency over MCP | **Fixed** in FeltKit | feltkit `8b42b15` | `test/mcp-idempotency.test.ts` (tests 1–4 fail before, against `c3bef54`) | implemented, tested, pushed, **merged** (PR #145); **not published** |
| G1a | Malformed `_meta` refused for app tools but accepted by FeltKit's agent tools, which then ran (`feltkit_agent_create` persisted a task). Found by CodeRabbit Verify on PR #145, reproduced here | P2 / MCP input validation | **Fixed** | feltkit `9651ab3` | same file, "agent tools too" (fails before) | implemented, tested, pushed; not merged; not published |
| G1b | MCP replay tests compared `structuredContent`, which MCP does not set for string outputs: the "returns the stored response" checks were vacuous | test quality | **Fixed**; added cross-principal, cross-session and authorization-bypass cases | feltkit `c4d8263` | same file, 7 tests | pushed; not merged |
| G2 | Session end (sign-out elsewhere, revocation, expiry) left the participant present for everyone else for 50–56 s; a hostile client kept media flowing that long | **P0-class** (authority not enforced in time) / session-bound presence | **Fixed** with a FeltKit contract, `ctx.auth.session` + `auth.onSessionEnd`, adopted by Meetings | feltkit `7276b21`; meetings `ba1484b` | feltkit `test/session-bound-state.test.ts` (7); meetings `tests/session-bound.test.ts` (6, **fail on published 0.3.32**), `scripts/e2e-termination.mjs` (strict bounds), `scripts/e2e-session-expiry.mjs` | implemented, tested, pushed; FeltKit part not merged, not published → **open for consumers** |
| G3 | FeltKit suite: 6 tests failed where `FELTDB_URL` was set (tests inherited the machine's deployment configuration) | P2 / test isolation | **Fixed** (test boundary; no product change, no skips) | feltkit `8325f33` | `test/environment-isolation.test.ts`; the 6 tests pass with the ambient environment | pushed; not merged |
| G4 | `measure` counted app-built presence, relays and media transports as domain/experience | P2 / measurement accuracy | **Fixed** (3 detectors + ownership check); negative fixtures added | feltkit `34f1f7e`, `ce0603f` | `test/measure.test.ts` (positive, negative, `--check`) | detectors merged (PR #145), negatives pushed; **not published** |
| G5 | TURN over TCP with all UDP blocked at one site: no connection | P1 / network compatibility | **Open**, reproduces without the app (bare `RTCPeerConnection`) | — | `scripts/netlab/run.sh 5` (reports OPEN) | not app code; next step TURNS:443 with a production provider |
| G6 | No real-network (independent devices and networks) evidence | P1 / interoperability | **Open**: needs a public deployment and devices outside this sandbox | — | — | blocker for interoperability claims |
| G7 | Chat and reaction rate limits | P1 / abuse | **Open**; platform quotas (proposal P3) preferred to more app counters | — | — | not started (closure only) |
| G8 | Signaling rate limits, roles, SDP validation | P1 | Fixed in Phase 3 | meetings `6adceee` | `tests/signaling.test.ts` | pushed; app-only, needs no platform release |
| G9 | Capacity on real devices | P2 / sizing | **Open**: this host measures 3 people (CPU-bound, all browsers on one host) | — | `scripts/capacity.mjs` | needs devices |
| G10 | An expired agent session is refused on `/mcp` with "An agent session token is required" (reads as missing, not expired) | P3 / diagnostics | **Open**, recorded | — | `scripts/e2e-session-expiry.mjs` shows the message | not fixed |
| G11 | `feltkit dev` once stopped reloading a function module until restarted | P2 / developer experience | **Open**, not reduced to a reproduction | — | — | not fixed |
| G12 | TURN credentials valid 4 h for whoever holds them | P2 / relay abuse | **Open**; shorter TTL with renewal (`setConfiguration`) | — | — | not fixed |
| G13 | Presence (P1 beyond session binding), transient messages (P2), quotas (P3) | platform capability | **Proposal** with todo regression tests | feltkit `0426198` (merged), `7276b21` (status) | `test/presence-contract.test.ts` (todo) | not implemented |

## G2 in detail: what is enforced, and by whom

| Event | Before (Phase 3, published 0.3.32) | After (local build of feltkit `ce0603f`) | Mechanism |
|---|---|---|---|
| Host revokes access / removes a connection | others close in ~0.25 s | unchanged, ~0.25 s | app write → live queries |
| Sign-out elsewhere | others 50.5 s | **others ~0.26 s**, also against a client that ignores teardown | FeltKit records the end in the transaction that removes the session; `auth.onSessionEnd` → `calls:sessionEnded` → live queries |
| Session revoked elsewhere | others 49.8 s (hostile: 56.4 s) | **~0.25 s** (hostile: ~0.26 s) | same |
| Session expiry | gone 60 s after the last check-in | **gone 4.7 s after expiry** | FeltKit's services worker ends expired sessions every 5 s |
| Heartbeat from another session, no session, an invented token | another session's accepted (same person) | refused (`reason: "session"`), 401, 401 | `peers.sessionRef`; FeltKit authentication |
| Reconnect after the session ended | — | new connection; the ended one is never revived | `replaces` ends only a live connection of the caller |
| Own browser after losing authority | stopped in 11–12 s | stops in ~0.26 s (it sees its own connection end) | cooperative client |

**Enforcement boundary.** The platform ends the participant's *authority* (presence, signaling, the right to
post or read) at once, and every other participant's client learns it at once through its live queries. Media
in this application flows directly between browsers (WebRTC mesh), so the platform cannot stop bytes itself:
a cooperating client closes its side immediately (measured), and once every other participant has closed its
side, a hostile client has no peer left to send to. Two hostile clients that both ignore the platform could keep
a direct connection between themselves; only a server in the media path (an SFU, which can drop a participant)
enforces media without any client's cooperation. That is the documented limit of peer-to-peer media.
