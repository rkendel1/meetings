# Meetings as a starter

A video-meeting product where **people and agents attend together**, kept small enough to read in an afternoon and
shaped so a team can make it theirs: brand it, point it at a model, decide which agents may attend, and change the
domain without touching infrastructure. This page says how to do that, what [FeltKit](https://www.npmjs.com/package/@feltdb/feltkit)
provides, what this application had to write itself, and where the limits are.

Everything below was measured on 2026-11-23 against `@feltdb/feltkit` 0.3.37 (`npm test`, `npm run e2e:starter`,
`npx feltkit measure --check`). What was **not** run is stated in [Not verified](#not-verified).

## Make it yours (no code)

| To | Do |
|---|---|
| **Brand it** | Sign in as an admin → **Settings**: name, tagline, accent colour, logo. It is a public query, so the sign-in page wears it before anyone signs in, and every open page changes at once. |
| **Turn on the model** | `npx feltkit model set --provider anthropic --model <model> --api-key-stdin` (or Studio → Models). Any provider FeltKit supports, or a Resolver reference. Without one, "Write an AI recap" and "Ask AI" say so; everything else works. |
| **Run housekeeping** | Studio → Services → Schedules: job type `maintenance.sweep`, every minute. It ends calls nobody is writing to, sends due reminders, applies retention. (Settings → "Run the sweep now" does it once.) |
| **Keep meetings N days** | Settings → retention. The sweep deletes meetings that long after their last call. |
| **Let an agent in** | `npx feltkit session create --type agent --id claude --role agent` (or an API key in production), then the host adds `claude` to the invited ids, or opens the meeting to any agent. Agents the host did not approve cannot even see that the meeting exists. |

## What a meeting leaves behind

| | Who writes it | Where people see it | Where agents see it (MCP tools) |
|---|---|---|---|
| Timeline: chat, captions, notes, reactions | people, agents | call panel, recap | `meetings_feed`, `chat_send`, `notes_add` |
| **Action items**: text, owner, due date, status | people, agents, the scribe, the model | Records tab, recap, "Assigned to you" | `actions_add`, `actions_update`, `actions_list` |
| **Decisions** | people, agents, the scribe, the model | Records tab, recap | `decisions_add`, `decisions_list` |
| **Summaries** (versioned, never overwritten) | the scribe (outline), the model (written recap), people, agents | recap | `summaries_save`, `summaries_get` |
| **Search** across meetings you took part in | | Home | `search_find` |
| **Notifications**: assigned, due, recap ready | the application | `inbox:list` | `inbox_list` |
| **Recording** notice | the host | banner for everyone; file saved on the host's device | visible in `meetings_get` |

The **scribe** (`app.agent`) runs when a call ends, however it ends (last person leaves, host ends it, session
expires, sweep): it writes the outline and collects lines marked `action: @name do X by 2026-12-01` and
`decision: …` from chat, captions and notes. The **model** is asked for by a person ("Write an AI recap"), as that
person; its summary, decisions and action items are stored through the same functions and checks as anything typed,
labelled with the model and the FeltKit agent task that holds the generation's evidence. The **assistant** answers
"Ask AI" in the timeline as its own agent, from the call and (optionally) earlier meetings, so an answer is never
attributed to the person who asked.

Participants write the transcript, so it is treated as untrusted data everywhere: the model is told so and is only
ever asked for data (a summary, lists), never tool calls; agent tool descriptions say it too.

## What FeltKit provides, and what this application wrote

Application code measured by `feltkit measure` (non-blank, non-comment lines):

| | Before (the 2026-11-19 meetings app) | Now | Added |
|---|--:|--:|--:|
| Domain (`feltkit/`: collections, rules, functions, agents) | 537 | 1,392 | **+855** |
| Experience (`src/`: UI, styles) | 1,457 | 1,824 | +367 |
| Infrastructure (app-built plumbing) | 714 | 787 | +73 (the browser recorder) |
| Configuration | 112 | 119 | +7 |
| **Authored** | 2,820 | **4,122** | **+1,302** |
| Tests | 1,569 | 1,991 | +422 |

The +855 domain lines buy, per capability (lines of server code in the files that implement it):

| Capability | App code | What FeltKit supplied instead of code |
|---|--:|---|
| Action items, decisions, summaries (records, validation, who may read/write, assignee resolution, dedupe) | 413 | Collections and schema checking; role + `access` authorization on every function; live queries to the UI; each function with a `capability:` becomes an MCP tool with its authority checked per call, so agents got 9 new tools with no MCP code; notifications and delivery; idempotency. |
| The scribe and the assistant (agents) | 80 | `app.agent`: a declared principal with its own role, run after commit, at least once, with leases, retries and writes that commit at most once per trigger; the outbox; Studio visibility. |
| Model recap and "Ask AI" | 107 | `ctx.model.generate`: provider, credential custody, streaming, timeouts, durable generation evidence on an agent task; `ctx.agent.openTask`. The app wrote the prompts and the strict parser. |
| Search | 65 | Queries with the caller's authority; indexed reads. (The matching is app code: FeltDB has no text index.) |
| Branding and retention | 61 | `access: "public"` queries; roles for who may change it; schema. |
| Housekeeping sweep | 42 | Jobs and schedules (re-authorized as the admin on every run); notifications. |
| Recording state and consent notice | 39 (+68 browser-side) | Authorization, live queries to every participant, the timeline. |
| Agent admission, delete, export | ~48 | Roles and per-function authority; transactions. |

What this application **still has to own**, because FeltKit has no capability for it (declared in
`feltkit.measure.json` and checked in CI by `feltkit measure --check`):

| Owned code | Lines | Why |
|---|--:|---|
| Presence leases and call settlement (`_presence.ts`) | 62 | no TTL/lease or time-aware live queries |
| WebRTC signaling relay (`signals.ts`) | 59 | no transient, per-subscriber-authorized messages |
| Media transport (`rtc.ts`, `media.ts`) | 186 | no media layer |
| Browser recording (`recorder.ts`) | 68 | no media layer; no large-object storage |
| **Total** | **375** | of 4,122 authored lines (9%) |

Everything else in the product (accounts, sessions, roles, tenancy-ready auth, MCP, API keys, the model, durable
agent runs, jobs, notifications, evidence, the Studio, deployment) is FeltKit's, not this repository's.

## What changed the evolution story

Three things the starter showed about the shape of the work:

1. **A new capability is a file, not a project.** Each row of the table above is a few collections and functions in
   one or two modules. None required touching the media code, the auth code or the deploy config. The one cross-cutting
   change (agents need host approval) was a single predicate, `mayAttend(meeting, id, kind)`, called from the places
   that already asked "may this principal be here?".
2. **Agents are users of the same functions.** The scribe, the model, an outside agent over MCP and a person all
   call `addAction`/`addDecision`; the checks, the notification and the dedupe exist once. Adding the model changed
   no storage.
3. **Authority is explicit and it caught a bug.** The first scribe run failed in a test: its role lacked
   `notifications.send`. FeltKit recorded the refusal (`agent/scribe called notifications.send as scribe … does not
   grant`), the test helper surfaced it, and the fix was one permission on one role.

## What FeltKit could not provide (and how this starter works around it)

| Need | Workaround here | Limit |
|---|---|---|
| Recording | The host's browser records the mixed call and saves a file on the host's device; the server keeps the notice, who started it and when, and stops it when the call ends. | Memory-bound (long calls), host-only, no server copy, no transcription of audio. A recording bot or SFU recorder replaces `recorder.ts`. |
| A complete transcript | Captions come from each person's browser (Chrome/Edge/Safari); anyone with captions off, or a browser without them, is not transcribed. | Recaps are only as complete as the captions and chat. Server-side speech-to-text needs audio at a server (SFU or bot). |
| The model at call end | `app.agent` handlers have no `ctx.model` (only `app.action` does), so the scribe is deterministic and a person asks for the model's recap. | No automatic AI summary without a person. |
| Declaring a schedule | The sweep job is registered, but the schedule is created in Studio. | One manual step per environment (`config import` skips schedules). |
| Full-text search | A bounded scan (20,000 timeline lines per search; says when it was cut). | Fine for a team; a large tenant needs an index. |
| Per-workspace branding | One brand per deployment. | A multi-tenant SaaS needs `auth.tenant` and tenant-scoped collections. |
| Guests without accounts | Not possible: every attendee has a FeltKit identity. | No anonymous guest link. |
| TURN/STUN | Known and accepted: not installed. | Calls across strict NATs fail. |

The upstream asks that would remove these are in [UPSTREAM-ASKS.md](UPSTREAM-ASKS.md).

## Not verified

- **No browser run of the new UI.** The sandbox this was built in would not install a browser. The new screens
  (Settings, Records tab, recording, recap sections, search, "Ask AI") typecheck and build, and their server side
  is exercised, but nobody has clicked them. `scripts/e2e.mjs` and `scripts/e2e-session-expiry.mjs` were updated
  for host-approved agents and syntax-checked, not run.
- **The recorder** (`src/recorder.ts`) has not run in a browser.
- **Notifications** are delivered to the in-app inbox only; the app has no inbox screen (the `inbox:list` function and
  MCP tool work and are tested).
- **Retention deletes in one transaction per meeting**; a very large meeting has not been tested.
- The network lab and the browser suites from Phase 3.1 were not re-run on 0.3.37.

## Verification

```bash
npm test                      # 40 backend tests: records, scribe, search, recording, branding, sweep, deletion, agent admission
npm run typecheck && npm run build && npm run measure -- --check
npm run dev                   # then, in another shell:
npm run e2e:starter           # 7 checks over HTTP + MCP, with a loopback OpenAI-compatible model standing in for a provider
```

`e2e:starter` configures the running development server's model (`feltkit model set` to a loopback endpoint). Run it
only against a development server.
