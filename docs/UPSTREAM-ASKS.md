# Upstream asks

What would let this application delete code it owns or stop working around a limit. Written 2026-11-23 against
`@feltdb/feltkit` 0.3.37 (with `@appport/services` 0.20.0, `@appport/core` 1.11.0, `@feltdb/core` 0.22.0).
**Resolved by 0.3.37** (verified here): session-bound presence (`ctx.auth.session`, `auth.onSessionEnd`), MCP
`_meta` idempotency, the measure detectors. Priority: P1 blocks a commercial claim, P2 costs real code, P3 polish.
"Evidence" says how the need was shown: **built** (this repo has the workaround), **read** (in FeltKit's own docs),
**not checked** (inferred; verify before acting).

`eve2` was named in the request but is not in this repository or any installed package; it has no section here.

## FeltKit (`@feltdb/feltkit`)

| # | Ask | Replaces / unblocks | P | Evidence |
|---|---|---|---|---|
| K1 | Presence with lease expiry, and live queries that re-run as time passes | `_presence.ts` (62 lines) and the sweep's "end calls nobody writes to" | P1 | built |
| K2 | Transient messages: ephemeral, authorized per subscriber, no durable record | `signals.ts` (59 lines); typing and hand-raise fan-out | P1 | built |
| K3 | Per-principal and per-function rate limits and quotas, with `retryAfter` | chat/reaction abuse (G7); signaling limits are app counters today | P1 | read (SECURITY.md: none on FeltKit endpoints) |
| K4 | `ctx.model.generate` in `app.agent` handlers | The scribe cannot use the model; a person must ask for the AI recap | P1 | built |
| K5 | Declaring schedules in code (`services.schedules: [{ job, every }]`), and importing them with `config import` | The sweep needs a manual Studio step per environment | P1 | read (`config import` skips schedules) |
| K6 | Guest principal: link-scoped, display name, restricted role | Attendees without accounts | P1 | not checked |
| K7 | Per-workspace branding and public pre-auth tenant resolution (slug or domain) | One brand per deployment today | P1 | not checked |
| K8 | Resource-scoped grants (the host admits one agent to one meeting) | Agent admission is an app predicate over an `invited` list | P2 | built |
| K9 | Policies that address a resource by a unique field such as `code` | `meetingFor(code)` at every call site (G5) | P2 | read (AUDIT.md) |
| K10 | A test helper that waits for detached agent runs and fails on failed outbox effects (`await t.settle()`) | `drain()` in `tests/records.test.ts`; `runServices()` returns while a run is still performing | P2 | built |
| K11 | `app.agent` on AppBoundry (FK-GAP-013); a long-lived agent session not tied to a heartbeat | resident scribe or researcher | P2 | read |
| K12 | A component pattern for a media worker (SFU adapter, recording bot) | recording and server-side transcription | P2 | not checked (COMPONENTS.md exists) |
| K13 | A distinct error for an expired agent session on `/mcp` (G10); `feltkit dev` module-reload fix (G11) | diagnostics | P3 | read |

## AppPort (`@appport/*`)

| # | Ask | Why | P | Evidence |
|---|---|---|---|---|
| A1 | Subscriptions authorized by the application's `Authorizer` (A8) | The measure file cites it as the reason signaling is durable records | P1 | read |
| A2 | MCP server notifications / resources so an agent subscribes to the transcript | Agents poll `meetings_feed` and check in every 30 s | P1 | not checked |
| A3 | A handler can report `OUTCOME_UNKNOWN` itself (A5) | model and speech-to-text calls that may have run | P2 | read |
| A4 | Authorize before validating input (A6); deny-as-not-found (A9) | a meeting code is the secret; existence must not leak | P2 | read |
| A5 | Stable subscription ids on the HTTP stream (A10); HTTP mapping for namespaced error codes (A7) | observability | P3 | read |

## AppPort Services (`@appport/services`)

| # | Ask | Why | P | Evidence |
|---|---|---|---|---|
| S1 | Jobs that run as the application's service principal, not the enqueuer's session | Jobs are re-authorized as their creator; if that session ends (this app's own `sessionEnded` hook does that), pending work is refused | P1 | read (feltkit-services skill) |
| S2 | Files: large objects, an object-storage provider (S3/R2) with presigned and resumable upload, lifecycle, per-tenant quotas | recording and larger logos; the default cap is 1 MiB | P1 | read (GUARANTEES.md) |
| S3 | Intelligence beyond chat: speech-to-text and embeddings, with per-tenant usage and cost metering | transcription and meeting search | P1 | not checked |
| S4 | Notification channels (email, push) exposed by FeltKit, reaching non-users | assigned items, reminders, guest invitations. AppPort Services has a `NotificationChannelRegistry`; FeltKit exposes only the in-app inbox as far as this repo could tell | P2 | read (services source), FeltKit side not checked |
| S5 | An outbound HTTP connector with evidence, available to hosts | TURN, speech-to-text, calendar | P2 | read (UPSTREAM-GAPS.md) |
| S6 | Carried over, re-verify: credential-reference read (S3b), `credential.remove` (S9a), webhook counts per application (S3a), replay ownership (S8) | operations | P3 | read (UPSTREAM-GAPS.md, 2026-11-03) |

## FeltDB (`@feltdb/core`)

| # | Ask | Why | P | Evidence |
|---|---|---|---|---|
| D1 | Record TTL and expiry | presence, signals, peers | P1 | built |
| D2 | Ephemeral collections that skip the operation journal | signal records are written and deleted constantly; backup reads the whole journal (F19) | P1 | read |
| D3 | Full-text search, ideally a vector index (F23) | `search.find` scans, bounded at 20,000 lines | P1 | built |
| D4 | Multi-value index on array fields | `meetings.list` and search scan every meeting (`invited` is an array) | P2 | built |
| D5 | Commit listener (F7); content deletion with reference counting (F8); collection listing (F19) | FeltKit workarounds | P2 | read |
| D6 | Journal compaction and retention | long-running tenants | P2 | not checked |
| D7 | Re-verify: silent default page of 100 (F20), returned objects not copies (F22) | correctness traps | P3 | read |

## Not an upstream ask

Media transport, recording, server-side speech-to-text and TURN/STUN. FeltKit's scope ends at authority and state;
those need an SFU or a recording bot. K12 and S2 only make that integration cleaner.
