# Meetings: completeness, reliability and platform audit

> **Update 2026-11-23.** This audit is of FeltKit 0.3.32 as of 2026-11-18. Since then: agents need host approval, and meetings keep action items, decisions and summaries; they can be searched, exported and deleted, recorded on the host's device, and branded. Rows below that say "Recording ❌", "No AI summary", "No delete" or "agents join by link" are superseded; see docs/STARTER.md.

Audit of this repository (FeltKit 0.3.32) against [convex-meetings](https://github.com/saranatour1/convex-meetings)
(Convex + TanStack Start + Cloudflare RealtimeKit), 2026-11-18. Every claim below cites a test, a
script run, or a file. "Verified" means an automated check in this repository exercised it; anything
else says so.

Evidence sources:

- **B** = backend tests, `npx feltkit test` (`tests/meetings.test.ts`, `tests/audit.test.ts`; 14 tests, in-process FeltDB, controlled clock)
- **E** = browser E2E, `node scripts/e2e.mjs` (14 scenarios, real Chromium, fake devices, one machine)
- **P** = probes run during the audit (results quoted here; scripts not kept in the repo)
- **R** = reading the code

## 1. Feature completeness

Status: **✅ verified**, **🟡 incomplete** (implemented with a stated gap, or implemented but not exercised), **❌ not implemented**, **↔ intentionally different**.

| Area | Status | What exists, and the evidence | Gap |
|---|---|---|---|
| Meeting creation | ✅ | Home → "Start a meeting now" / "Create" (E1, B) | — |
| Scheduling | 🟡 | Optional time at creation, shown in the list (R) | No reschedule, time zone handling, reminders or calendar (.ics) |
| Editing | 🟡 | Host edits access and invitees in the call's People tab (E "revoking access") | Title and time are editable only through the API (`meetings:update` has `title`); no edit screen outside a call |
| Deletion | ❌ | — | No delete or cancel. Meetings and their timelines are kept forever |
| Codes and links | ✅ | `abc-defg-hij`, `/m/<code>`, recaps at `/m/<code>/recap/<n>` (B, E) | — |
| Access policies | ✅ | `link` (anyone signed in with the code) or `invited` (host + listed principal ids), checked in every function (B "invited meetings", "revoking an invitation") | — |
| Invitations | 🟡 | Invitees by principal id; a `meeting.invited` notification is sent (R) | No inbox UI shows it (the starter's was removed), no e-mail, no accept/decline, ids rather than people pickers |
| Membership / orgs / roles | ❌ | App roles only (`member`, `agent`, `admin`) | No organizations, custom roles or audit log. FeltKit already has workspaces and invitations (see §4) |
| Identity and authentication | 🟡 | Dev users; built-in e-mail/password accounts (platform, configured in `feltkit/app.ts`) | Account sign-in is FeltKit's and is not exercised by this repo's tests. No Google/GitHub (platform config only), no passkeys, no guests without an account |
| Lobby | ✅ | Preview, mic/camera toggles, waits for devices before Join (E1; the race was a found bug) | — |
| Device selection | 🟡 | Microphone/camera pickers in the lobby (R) | Not exercised (fake devices); no switching mid-call; no speaker selection |
| Audio/video lifecycle | ✅ | Connect both ways with decoded frames (E1); permission denied → join receive-only (E "camera and microphone denied"); lost camera → camera off for everyone (E "lost camera") | Microphone loss shares the code path but is not exercised |
| Screen sharing | ✅ | Replaces the outgoing video track; others switch to a stage layout (E1) | Replaces the camera (no camera + screen at once); no tab audio |
| Presence and connection status | ✅ | Heartbeat every 15 s, expiry after 45 s, per-connection state on tiles (B "presence"; E "offline past the presence timeout", "host's browser dies") | A crashed connection is visible as "Reconnecting…" for up to 45 s |
| Chat | ✅ | Ordered per meeting, concurrency-safe (B "concurrent chat": 30 writers, gap-free) | No moderation, slow mode, edit or delete |
| Reactions | ✅ | Six emoji, floating overlay, counted in the recap (B, E) | — |
| Raised hands | ✅ | Per connection (B "raised hands") | Not exercised in a browser |
| Captions | 🟡 | Each person's browser transcribes their own speech (Web Speech API); lines persist in the timeline (B) | Cannot run headless, so not exercised in a browser. Chrome/Edge/Safari only. Chrome sends audio to Google's service (disclosed in the UI) |
| Transcript persistence | ✅ | Captions are timeline entries, in the recap and `meetings.feed` (B) | — |
| History and recaps | ✅ | Per call: times, attendance per person/agent with devices and minutes, notes, reactions, timeline; call selector (B, E) | No AI summary of its own (an agent writes it via `notes.add`, by design); no recording |
| Host controls | ✅ | Remove a connection, end for everyone, change access (B "host removes", E "revoking access") | No mute-others; "End for all" button not exercised in a browser (the mutation is, B) |
| Agent identity and permissions | ✅ | Agents are principals with role `agent`; any non-`user` principal is an agent (B "non-person principal") | API-key agents in production are not exercised end to end |
| Agent participation | ✅ | Join (presence, no media), feed, chat, react, notes; must be visible to read a live call (B, E) | — |
| MCP discovery and invocation | 🟡 | `tools/list` shows only the agent's allowed tools; calls run as the agent (E) | **Idempotency keys sent over MCP are dropped by FeltKit** (E, known platform gap; §4 G1) |
| Meeting lifecycle and cleanup | ✅ | Refresh continues the same call; a 60 s grace keeps an empty call open; explicit Leave by the last person ends it; agents never keep a call open; stale signaling deleted (B, E) | No retention policy for timelines |
| Waiting room / join requests | ❌ | — | — |
| Ringing | ❌ | — | — |
| Recording | ❌ | — | — |
| Public rooms + AI moderation | ❌ | — | — |
| Annotations / whiteboard | ❌ | — | — |
| Usage caps, rate limits | ❌ | — | Also a security item (§3) |
| Media transport | ↔ | Browser-to-browser WebRTC mesh, signaling through FeltDB | The reference uses Cloudflare RealtimeKit (SFU). See §5 |
| How agents join | ↔ | Agents are principals with their own role, over MCP | The reference detects agents by browser user agent or typed name and gives them a guest page |
| Live transcription | ↔ | Per-person browser speech recognition | The reference uses Deepgram |
| Browser-side tools (WebMCP) | ↔ | Server-side MCP at `/mcp` | — |

**UI without a complete backend:** none found. The reverse exists: invite notifications are sent but
nothing displays them, and `meetings:update` accepts a title that no screen edits.

## 2. Reliability: test results

Run on 2026-11-18 against `npm run dev`. All passed, except the one known platform gap.

| Condition | How it is tested | Result |
|---|---|---|
| Two people, media both ways, screen share | E1 | ✅ decoded remote frames both ways; stage layout on the other side |
| Browser refresh during a call | E "a third person joins while another reloads"; B "presence" | ✅ the reload rejoins without the lobby, replaces its old connection (no ghost tile) and continues the same call |
| Joining while another participant reloads | Same E scenario (three people at once) | ✅ all three pairs connected, one tile each |
| Short network drop (8 s offline) | E "short network drop" | ✅ heartbeats and live queries recover; chat flows both ways |
| Long network drop (past 45 s) | E "offline past the presence timeout" (~62 s) | ✅ others drop the tile; on reconnect the tab rejoins by itself (`replaces`) and media reconnects |
| Permission denied | E (separate browser, no permissions) | ✅ joins receive-only and sees others' video |
| Device disconnected | E (camera track `ended`) | ✅ camera off for everyone; the person is told |
| Duplicate presence (same person, two tabs) | E "camera and microphone denied" (Ada's second device) | ✅ both listed; no media between one person's own connections (no feedback loop) |
| Stale participant cleanup | B "presence" (controlled clock), E | ✅ expired at last check-in, `leftReason: "expired"`, its signaling deleted |
| Host disconnects unexpectedly | E "host's browser dies" (~43 s) | ✅ the call continues; the host's tile goes after expiry |
| Last person leaves while an agent remains | B, E last scenario | ✅ explicit Leave ends at once; a crash ends after the 60 s grace; the agent is told "No call is running" |
| Concurrent first joins (3 people) | B "concurrent first joins" | ✅ one call (conflicts are retryable; the client retries) |
| Concurrent agent check-ins | B (3 at once) | ✅ one presence |
| Concurrent chat (30 writes, 3 writers) | B | ✅ gap-free sequence, none lost |
| Join during a departure | B "explicit leave… joiner during someone's departure" | ✅ the joiner ends up in an open call |
| Access revoked mid-call | B "revoking an invitation", E "revoking access" | ✅ evicted at once (`leftReason: "removed"`); heartbeat, signaling and reads refused |
| Session revoked (agent) | E "a revoked agent session" | ✅ refused on the next call |
| Replayed operation, AppPort HTTP | E | ✅ same result, no second write; the same key with another body → `IDEMPOTENCY_KEY_REUSED` |
| Replayed operation, MCP | E `[known gap]` | ⚠ **runs twice**: FeltKit's `/mcp` ignores `params._meta` (§4 G1) |
| Mesh at 3 people | P (getStats) | ✅ each browser: 2 connections, one video encode per connection (~320–330 kbps at 960×540, 17–19 fps, 17 s after connecting), via `host/udp` |

**Not established, and not claimed:** media across different networks, NATs or firewalls. Every
browser here shares one host, so ICE always finds a `host` candidate pair. The sandbox cannot reach the
default STUN server (`stun.l.google.com`, probe: no connection), so server-reflexive candidates were never
gathered. Microphone loss, speaker selection, mobile browsers, Firefox and Safari were not exercised.

## 3. Security and authorization

Model: a person is a principal of type `user`. **Every other principal** (agent sessions, API keys,
services) is an agent: no media, never counts as a person, and cannot create or host meetings, whatever
its roles. Roles decide the function. Per-meeting rules (`feltkit/_meeting.ts`) decide the record. Both
are checked on the server for every interface (app, `/api`, `/appport`, `/mcp`).

### Found and fixed (P0)

| # | Finding | Reproduced by | Fix |
|---|---|---|---|
| S1 | **Silent eavesdropping.** Anyone with a link meeting's code (person or agent) could read a running call's chat and captions through `meetings.feed`/`recap` without appearing in it | B "a non-attendee cannot silently read" (failed before the fix) | `mayReadCall`: a running call is readable by the host and whoever is visibly in it; afterwards by the host, invitees and attendees. Posting into a running call needs presence too |
| S2 | **Revocation did not revoke.** Removing an invitee, or switching a meeting to invite-only, left them in the live call: heartbeats, signaling and reads kept working | B "revoking an invitation" (failed) | `meetings.update` evicts whoever may no longer attend; `ownPeer` re-checks access on every connection-scoped call |
| S3 | **An API-key or service principal with the agent role counted as a person.** It could start calls, keep them open alone, and create meetings | B "a non-person principal" (failed) | `kindOf`: only `user` principals are people |
| S4 | **Identity spoofing in durable records.** `calls.join` took a display name, so a person could join as "Ada Lovelace" and their captions were attributed to that name in the recap that agents read | R; B "names are not trusted" | The argument is removed; the name is always the principal's |

### Verified to hold (tests that attempt the unauthorized operation)

- Agents are refused (`FORBIDDEN`/`NOT_FOUND`) for: changing access, ending the call, removing a person, captioning, sending or reading signaling, and heartbeating another's connection (B "agents are refused…"). They are also refused through the HTTP function API with 403 (E), and those tools are absent from `tools/list` (E).
- People cannot heartbeat, signal from, or remove another's connection. `leave` only touches the caller's own connections (B).
- Invite-only meetings answer `NOT_FOUND` to non-invitees, people and agents alike, so a code's existence is not revealed (B).
- Cross-meeting: signaling only between connections in the same call; a caption needs the caller's own connection in that meeting (B, R).
- Untrusted content: no raw HTML sinks in the frontend (R: no `dangerouslySetInnerHTML`/`innerHTML`); React escapes all text. The MCP descriptions of `meetings.feed`/`recap` tell agents that entry text is untrusted data, not instructions.
- Tokens: the browser session is an HttpOnly cookie with CSRF (FeltKit). The Agents tab shows a `<token>` placeholder, never a token. Agent sessions are issued only by an operator (`feltkit session create`) and revoke immediately (E).
- Input: schemas bound every string (code ≤ 64, title ≤ 120, text ≤ 4000, SDP ≤ 200 kB, ≤ 100 invitees).

### Open

| # | Finding | Severity |
|---|---|---|
| S5 | **No rate limiting.** A participant can flood chat or reactions. A connection can send unlimited 200 kB offers to a peer, and each one makes that browser rebuild its connection (a targeted denial of service). FeltKit has no per-principal limits (its docs defer to a reverse proxy, which cannot see meetings or principals) | P1 |
| S6 | **Media authorization is enforced by clients in a mesh.** Revocation stops signaling and drops the person from everyone's list (B, E), but the bytes flow browser to browser. The server cannot cut an established media connection; it relies on the other clients closing it. An SFU makes this server-enforced (§5) | P1 (architecture) |
| S7 | Invitee ids and the host id are visible to anyone who may open the meeting (`meetings.get`) | P2 |
| S8 | A link meeting is protected only by its code (25¹⁰ ≈ 9.5×10¹³ codes) and sign-in. With open sign-up and no rate limiting, guessing is bounded only by request throughput | P2 (with S5) |
| S9 | A person whose session is revoked keeps media for up to 45 s: the client treats `UNAUTHORIZED` heartbeats as network trouble until the connection expires | P1 |

## 4. Platform audit: what FeltKit provided and what the app built

### Lines of code (non-blank, non-comment)

`npx feltkit measure` with `feltkit.measure.json`, which declares the app-built infrastructure:

| Class | LOC | Files |
|---|--:|---|
| Domain (meeting rules, functions, schema) | 511 | `feltkit/app.ts` 94, `meetings.ts` 155, `calls.ts` 109, `_meeting.ts` 76, `chat.ts` 62, `_schemas.ts` 15 |
| Infrastructure the app built | 208 | `src/rtc.ts` 140 (media mesh), `feltkit/signals.ts` 35 (signaling relay), `feltkit/_presence.ts` 33 (leases, settlement) |
| Experience (UI) | 1439 | `Call.tsx` 703, `styles.css` 193, `auth.tsx` 181 (starter, moved), `Home.tsx` 104, `App.tsx` 94, `Recap.tsx` 93, `util.ts` 56, rest from the starter |
| Configuration | 68 | |
| Tests | 611 | `tests/` 356, `scripts/e2e.mjs` 255 |

Without the declarations, `measure` counts presence and signaling as "domain" and reports
"Infrastructure findings: None": a blind spot (G4).

### What the platform provided (zero app code)

Durable storage with schema enforcement and migration (one optional field added mid-audit:
`Schema v1 → v2 applied`). Atomic mutations with read fences (the concurrency tests pass without
locks). Per-stream sequences (`ctx.db.sequence`, gap-free under 30 concurrent writers). Live queries for
every screen, the signaling inbox included. Sessions, the cookie and CSRF, dev identities, built-in
accounts. Role checks on every interface. AppPort capabilities and the MCP server with per-principal
tool lists. Agent sessions and revocation. Idempotency on AppPort HTTP. Notifications with after-commit
delivery. Studio. Test harness with isolated FeltDB and restart. Production build and deploy artifacts.

### Is the app using what exists?

| Need | Platform has it? | App today | Action |
|---|---|---|---|
| Organizations, membership, invitations by e-mail | Yes: workspaces, invitations, member roles (`docs/AUTH.md`) | Not built | Use it for P2 orgs; don't build |
| Audit log of host actions | Yes: `app.auditTrail` | Host actions only appear as system lines in the timeline | P1: record access changes, removals and ends (~20 LOC) |
| Google/GitHub sign-in | Yes: `auth.providers` (with a sign-in broker) | Not configured | Configuration only |
| Reminders, e-mail | Schedules, jobs, Mailerport | Not built | Use them when scheduling is built |
| Notifications inbox | Yes: notifications service | Sends, but no inbox | P1: show it (the starter had one) |
| Replay safety | Yes: AppPort idempotency | Works on HTTP; dropped on MCP (G1) | Don't duplicate in the app; fix upstream |
| Per-record access | `app.policy` (`owner`, `sharedWith`) and the `authorize` hook | A helper (`meetingFor`) called by each function | Policies need the record id; functions take the code (G5). Consider the `authorize` hook for defense in depth |

### Platform gaps (each with evidence; nothing invented)

| # | Gap | Evidence | Why the app should not own it | Belongs in | Reusable |
|---|---|---|---|---|---|
| G1 | **MCP drops idempotency keys.** `dist/server/mcp.js` calls `bridge.callTool(name, rpc.params?.arguments)` without `rpc.params._meta`; `@appport/mcp`'s `callTool(name, args, metadata)` supports it | E `[known gap]` (same key → 2 messages); AppPort HTTP with the same key dedupes | A second idempotency store in the app would duplicate the platform's, which already works on HTTP | FeltKit (MCP projection); one line | Every agent-facing app |
| G2 | **Presence / leases.** No record TTL or lease; live queries do not re-run as time passes | `feltkit/_presence.ts`; `lastSeenAt`, `isLive`, lazy settlement wherever a call is touched; "End time" computed after the fact | Every collaborative app needs "who is here now" with expiry. Built per app, it needs care around time and conflicts (this audit found 3 lifecycle bugs in it) | FeltDB (leases with expiry) + FeltKit (presence API, time-aware live queries) | Yes: cursors, typing indicators, multiplayer, device sessions |
| G3 | **Ephemeral, authorized, scoped messages.** Signaling is written to FeltDB and deleted after reading, because AppPort events are not authorized per subscriber and have no scope | `feltkit/signals.ts`, `endPeer` cleanup; FeltKit `UPSTREAM-GAPS.md` A8 / FK-GAP-004 | A durable, transactional store is the wrong tool for transient fan-out, and the app cannot fix event authorization | AppPort (authorized, scoped events), then FeltKit | Yes |
| G4 | **`measure` misses app-built infrastructure** | Report before declarations: "Infrastructure findings: None" | Measurement belongs with the platform's model of infrastructure | FeltKit (`measure` heuristics: heartbeat fields, delete-after-read queues) | Yes, every app's report |
| G5 | **Policies address records only by id** | `meetingFor(code)` at 11 call sites (every code-addressed function); `app.policy({ resource: { collection, id: "<arg>" } })` | Codes and slugs are the normal way to address shared resources; with id-only lookup, declarative policies cannot govern these functions | FeltKit policies (resource by unique field) | Yes |
| G6 | **Per-principal, per-capability rate limits** | S5; FeltKit `SECURITY.md`: "No rate limiting… put a reverse proxy in front" | A proxy cannot see the principal or the meeting. Counters in FeltDB would conflict under load, and every app would rebuild them | AppPort/FeltKit (declarative quotas on capabilities) | Yes |

## 5. Architecture: the media mesh

**What it is.** Each pair of people has one `RTCPeerConnection`. The smaller connection id offers, so
there are no negotiation races. ICE is gathered before sending (non-trickle, capped at 2.5 s), so a pair
exchanges exactly two signals. Fixed audio and video transceivers mean camera and screen changes swap
tracks and never renegotiate. A failed or stalled connection is offered again (failure → 1 s; not
connected after 15 s → re-offer).

| Topic | Assessment |
|---|---|
| Participant limit | Each person encodes and uploads N−1 streams (P: one encoder per connection). Real-world bitrates of 0.5–2.5 Mbps per 720p stream make **4–6 people** the practical ceiling, lower on laptops and mobile. Nothing caps bitrate or adapts resolution to N yet (P1, cheap: `setParameters` `maxBitrate` scaled by peer count) |
| TURN | None. Peers behind symmetric NATs or UDP-blocking firewalls will not connect (commonly 10–20% of pairs in corporate settings). TURN credentials must be short-lived and issued by the server (a capability returning HMAC credentials from a configured secret), never baked into the frontend via `VITE_ICE_SERVERS` |
| Signaling correctness | Durable inbox per connection (offline recipients get it later), dedupe by id, ack-delete, deterministic roles. Lost-answer recovery verified by the reload scenario. **Risk:** non-trickle ICE with a 2.5 s cap can send an offer without server-reflexive candidates when STUN is slow. Unverifiable here (STUN unreachable) |
| ICE configuration | One public STUN server by default; `VITE_ICE_SERVERS` overrides it at build time (static, public). No `iceTransportPolicy`, no ICE restart (a fresh connection instead) |
| Recovery | Verified for reload, a short drop, a long drop with expiry and rejoin, and a peer crash. Not verified: a network change (Wi-Fi → cellular) that keeps signaling but breaks the media path; it relies on the `failed` → re-offer path |
| Resources | Per remote person: one connection, one encoder, one decoder. Connections are closed when a peer leaves the list; tracks are stopped on leave. Signaling records are deleted on read and on connection end |
| Browser compatibility | WebRTC and `replaceTrack`: all current browsers. `getDisplayMedia`: desktop only (not iOS). Captions: Chrome, Edge, Safari (no Firefox). CSS `light-dark()`: Chrome 123+, Safari 17.5+, Firefox 120+. Only Chromium was tested |

**Path to an SFU, without building it now.** The media boundary is already two pieces:
`src/rtc.ts` (client: `sync(peerIds)`, `receive(signals)`, `setTracks()`, `remotes()`, `close()`) and
`feltkit/signals.ts` (server relay). Presence, chat, captions, recaps and authorization do not touch
media. To move to an SFU (LiveKit, Cloudflare Realtime, mediasoup):

1. Turn `Mesh`'s surface into a `MediaTransport` interface, with `MeshTransport` as the first implementation.
2. Add an `app.integration` for the provider's REST API and a `media.token` mutation, authorized by the
   same meeting rules, that mints a short-lived room token bound to the connection id.
3. Make removal and revocation also call the provider's "remove participant" through the integration. This
   makes media authorization server-enforced (closes S6).
4. Keep FeltDB as the source of truth for who is in the call. The SFU carries bytes only.

The provider stays behind the integration and the transport interface, so swapping it touches neither
the domain nor the UI.

## 6. Gap register

### P0: correctness and security

| Item | Status |
|---|---|
| S1 silent eavesdropping on live calls | **Fixed**, regression test |
| S2 revocation did not remove access | **Fixed**, regression test + E2E |
| S3 non-person principals counted as people | **Fixed**, regression test |
| S4 display-name spoofing in attributed records | **Fixed**, regression test |
| Lobby joined before devices were ready (no media sent) | **Fixed** in the first phase, covered by E1 |
| Lobby stopped the camera tracks it handed to the call | **Fixed** in the first phase, covered by E1 |

No open P0 is known in the application.

### P1: reliability (open unless marked)

| Item | Value | Cost |
|---|---|---|
| Refresh ended a solo call and split the recap; ghost tile after reload | Calls survive reloads | **Fixed**: `replaces`, non-final leave on `pagehide`, 60 s grace |
| Expired connection showed "removed" and stayed out | Self-healing after a network drop | **Fixed**: `leftReason`, automatic rejoin |
| One person's two tabs connected to each other (audio feedback) | Multi-device works | **Fixed** |
| Lost offers/answers stalled a pair forever | Self-healing signaling | **Fixed**: re-offer after 15 s |
| Device loss left a frozen or dead track | Honest state | **Fixed** (camera exercised) |
| No host UI to change access or revoke | Revocation usable | **Fixed**: access editor |
| TURN with server-issued short-lived credentials | Calls across real networks | Medium: a TURN service + one capability |
| Rate limits (S5) | Abuse resistance | Medium in the app; better in the platform (G6) |
| MCP idempotency (G1) | Safe agent retries | One line upstream |
| Bitrate caps scaled by participant count | Stable 4–6-person calls | Small |
| Treat `UNAUTHORIZED` heartbeats as removal (S9) | Revocation of signed-out people within 15 s | Small |
| Audit trail of host actions (`app.auditTrail`) | Accountability | Small; the platform has it |
| Notifications inbox for invitations | Invites are seen | Small; the platform has it |
| Timeline paging (the call view reads ≤ 500 entries per update) | Long calls | Small–medium |
| Normalize invitations (today `meetings.list` scans every meeting) | Scale beyond hundreds of meetings | Medium; overlaps with orgs |
| Test on real networks, Firefox and Safari, and mobile | Evidence for real-world use | Process, not code |

### P2: product completeness (from the reference). Explained, not built

| Feature | Value | Cost and recommendation |
|---|---|---|
| Organizations, roles, invitations | High for teams | **Low with the platform**: FeltKit workspaces and invitations. Do this first among P2 |
| Meeting delete/cancel, reschedule, .ics e-mail | High | Low–medium (Mailerport for e-mail) |
| Google/GitHub sign-in | Medium | Configuration |
| Waiting room / join requests | Medium | Medium: a `joinRequests` collection + host UI; reuses presence |
| Guests without an account | Medium | Medium: needs a scoped guest principal; security review |
| Ringing (instant calls) | Medium | Medium: notifications + live query; no new infrastructure |
| Recording | High for some teams | **High**: needs an SFU or a recording bot plus object storage. Wait for the SFU |
| Whiteboard / annotations | Medium | Medium–high; annotations need a low-latency channel (G3) |
| Public rooms with AI moderation | Niche | High; moderation is a model-backed pipeline over chat and frames |
| Usage caps | Operator need | Low once rate limits exist |

## 7. Verification commands

```bash
npm install
```

```bash
npx feltkit test        # 14 tests: tests/meetings.test.ts, tests/audit.test.ts
```

```bash
npx feltkit build       # backend bundle, schema contract, frontend
```

```bash
npx tsc --noEmit
```

```bash
npx feltkit measure     # LOC by class, using feltkit.measure.json
```

```bash
npm run dev             # in another terminal, then:
```

```bash
node scripts/e2e.mjs                 # 14 scenarios (~3 min); SKIP_SLOW=1 skips the two expiry scenarios
```

Expected E2E summary: `13/14 scenarios passed, 1 known platform gap(s), 0 failure(s)`. The known gap
is G1 and turns into a pass when FeltKit forwards MCP `_meta`.

---

# Phase 3: platform and network validation (2026-11-18)

Application changes are in this repository; platform changes are on `rkendel1/feltkit`, branch
`claude/gallant-cannon-k8j6e9`, each with its own tests. Nothing in the application works around a
platform defect.

## Completion criteria

| Criterion | Status | Evidence |
|---|---|---|
| No known P0 security defects | Met (open items are P1, below) | 23 backend tests incl. `tests/signaling.test.ts`, `tests/media.test.ts`; termination measurements |
| MCP idempotency works | **Met with the FeltKit fix** | FeltKit `test/mcp-idempotency.test.ts` (5 tests; 0/5 pass without the fix); app E2E "MCP: a replayed tools/call…" passes on the fixed build, reported as a known gap on published 0.3.32 |
| Media termination verified | Met, with a measured bound for session end | `scripts/e2e-termination.mjs`, 7/7 |
| Cross-network calls demonstrated | Met in an emulated network; **not on real independent networks** | `scripts/netlab/run.sh`: 4/5 scenarios as expected, 1 open |
| Rate limiting tested | Met for signaling | `tests/signaling.test.ts` |
| Platform changes have independent tests | Met | FeltKit `test/mcp-idempotency.test.ts`, `test/measure.test.ts`, `test/presence-contract.test.ts` (todo) |
| Application and platform builds pass | Met | commands at the end |
| Ownership measurements recorded | Met | below |

## Track A: meetings

### Media termination (scripts/e2e-termination.mjs)

Measured from instrumented browsers: when the participant's own peer connections and camera/mic tracks
stop, and when every other browser has closed its connection to them. "Adversarial" = a client that ignores
`close()` and `track.stop()`.

| Authorization ends by | Own media stops | Others' connection closed | Adversarial: others closed |
|---|---|---|---|
| Host revokes access (invite-only, removed from list) | 255 ms | 254 ms | 254 ms |
| Host removes the connection | 257 ms | 257 ms | 254 ms |
| Sign-out in another tab of the same browser | 11.9 s | 50.5 s | — |
| Session revoked from another device | 11.1 s | 49.8 s | 56.4 s |

Fixed in this phase: a heartbeat answered `UNAUTHORIZED` used to be treated as a network drop (media kept
running); it now ends the call in that browser. **Open (P1, platform P1 presence):** after a session ends,
others learn it only when the presence expires (~50–56 s), so a hostile client keeps media flowing for that
long. Meeting-level revocation is immediate and enforced without the client's cooperation.

### TURN with short-lived credentials

`feltkit/app.ts` declares `app.integration("turn")` against a TURN provider's credential API (Cloudflare
Realtime's `generate-ice-servers` shape). The provider token is in FeltKit's credential custody
(`credential-ref:turn`, production `FELTKIT_CREDENTIAL_TURN`); the operation is not exposed as a capability.
`media:iceServers` gives relay credentials (4 h TTL) only to a person with a live connection
(`tests/media.test.ts`). Development uses `scripts/turn-api-dev.mjs` in front of coturn (coturn REST
credentials, HMAC-SHA1, checked by coturn: an unauthenticated allocation gets 401, the issued credential
allocates).

### Cross-network calls (scripts/netlab)

Two sites, each behind its own NAT router (network namespaces + iptables), on an emulated internet with
coturn; one browser per site; the app's real ICE configuration. `RUNS=2 scripts/netlab/run.sh`:

| Scenario | Expected | Result (2 runs each) |
|---|---|---|
| Full-cone NATs (RFC 4787 EIM/EIF), STUN only | direct | ✅ srflx↔srflx, ~0.6 s, video both ways |
| Linux MASQUERADE NATs, STUN only | none | ✅ fails, as expected (see finding 1) |
| Symmetric NATs, STUN only | none | ✅ fails, as expected |
| Symmetric NATs, TURN | relay | ✅ relay/udp ↔ prflx, ~0.6 s, video both ways |
| Symmetric NATs, all UDP blocked at one site, TURN | relay over TCP | **open**: fails (finding 3) |

Findings:
1. **Plain Linux MASQUERADE defeats hole punching** when the peer's first packet arrives before the site's
   own (conntrack takes the mapping; the outbound packets leave on another port). Proven with packet
   captures and conntrack. Many Linux-based routers behave this way: TURN is needed more often than "cone
   NAT" suggests.
2. **A third-party STUN hostname that does not resolve broke relay connectivity** in the app: 0/3 with
   Google's STUN in the ICE list, 5/5 without. The app now uses only the provider's servers (also a privacy
   improvement: no third party learns participants' addresses). The Chrome-internal mechanism was not
   determined; a bare two-browser harness with the same list connected.
3. **TURN over TCP with all UDP blocked:** Chrome gathers the TCP relay candidate but forms no pairs with it,
   in the app and in a bare two-browser `RTCPeerConnection` alike. Not an app defect; unresolved. Next: test
   TURNS on 443 against a production provider.
4. Lab artefact found and removed: Chrome sends TURN-over-TCP through the host's configured HTTPS proxy
   (`ERR_PROXY_CONNECTION_FAILED`); the lab's browsers run with `--no-proxy-server`.

**Not done: independently located browsers on real networks.** This sandbox has no second machine or
network; the lab emulates NAT types on one host. Real-network testing needs the app deployed publicly and
browsers on separate networks (home, mobile, corporate), which is the remaining blocker for this criterion.

### Signaling limits (tests/signaling.test.ts)

Roles enforced on the server (smaller connection offers, larger answers); one pending signal of each kind
per pair (a newer one replaces it); 60 signals a minute per connection (`RATE_LIMITED` with `retryAfterMs`);
SDP must be a session description of at most 64 kB; no relay to agents, other calls, departed or revoked
connections; foreign inbox reads return nothing and foreign acks delete nothing.

### Capacity (scripts/capacity.mjs; real accounts; this host: 4 vCPU Xeon 2.1 GHz)

| N | Connected | Video streams | fps min / median | Uplink per person | Host CPU | |
|---|---|---|---|---|---|---|
| 2 | 3.3 s | 2/2 | 20 / 20 | 611 kbps | 21% | usable |
| 3 | 3.4 s | 6/6 | 17.6 / 18.4 | 1078 kbps | 72% | usable |
| 4 | 4.5 s | 12/12 | 6 / 7.3 | 629 kbps | 99% | not usable |
| 5 | 5.2 s | 20/20 | 2 / 5.1 | 624 kbps | 100% | not usable |
| 6 | 6.5 s | 30/30 | 0.8 / 4.1 | 556 kbps | 100% | not usable |

Signaling and connection set-up scale (30/30 streams connected in 6.5 s at N=6). The limit measured here is
the host's CPU, because every participant runs on it: **3 people on this host**. This replaces the earlier
"4–6" estimate. On separate devices each person carries only their own N−1 encodes and decodes; the same
harness run on separate machines is what establishes that number.

### Session expiry, cleanup, reconnection

`scripts/e2e-session-expiry.mjs` (agent session with a 36 s TTL, checking in every 10 s): refused at its first
check-in after expiry (+7 s, 401); its tile disappeared 60 s after its last successful check-in (45 s
presence + one settle); the recap records it leaving at its last check-in. Reconnection (reload, 8 s drop,
62 s drop with automatic rejoin, host crash) remains covered by `scripts/e2e.mjs`, 14/14 on the fixed
FeltKit.

## Track B: FeltKit (rkendel1/feltkit, branch claude/gallant-cannon-k8j6e9)

| Item | Change | Package | Test |
|---|---|---|---|
| MCP idempotency | `/mcp` forwards `params._meta` (idempotency key, timeout, trace) to AppPort; malformed `_meta` → JSON-RPC -32602 | `@feltdb/feltkit` `src/server/mcp.ts` | `test/mcp-idempotency.test.ts`: 5 pass with the fix, 0 without |
| Measure ownership | detectors `presence-lease`, `transient-relay`, `media-transport` (platform-gap candidates) and check *app-built infrastructure has an owner* | `src/measure/index.ts`, `docs/MEASURE.md` | `test/measure.test.ts` (11 pass) |
| Presence, transient messages, quotas | proposal with gap, evidence, contract, owner, regression tests | `docs/PRESENCE-AND-SIGNALING-PROPOSAL.md` | `test/presence-contract.test.ts` (10 todo) |
| Existing capabilities verified | workspaces, invitations, scoped data, removal, notifications; accounts end to end | (no platform change) | app `tests/platform-capabilities.test.ts`, `scripts/e2e-identity.mjs` |

Also found: an expired agent session is refused with a message that reads as a missing token; `feltkit dev`
once stopped reloading a function module until restarted (not yet reduced to a reproduction).

## Ownership (patched `feltkit measure`, with this repository's declarations)

| Class | Files | Lines |
|---|--:|--:|
| domain | 6 | 502 |
| experience | 8 | 1457 |
| infrastructure (app-owned) | 5 | 326 |
| configuration | 3 | 81 |
| tests (incl. acceptance, capacity, lab) | 14 | ~1,600 |

App-owned infrastructure is `feltkit/_presence.ts` (presence + the `peers` collection), `feltkit/signals.ts`
(relay + the `signals` collection + limits), `feltkit/media.ts` (ICE issuing), `src/rtc.ts` (mesh), and the
development TURN stand-in. P1 (presence) and P2 (transient messages) would remove the first two; P3 the limit
code. Without declarations, the patched `measure` now finds all three kinds and fails `--check` until they are
owned; published 0.3.32 found none.

## Remaining blockers and open items

- **Real-network calls** (independent locations, mobile, corporate firewalls): needs a public deployment
  and devices outside this sandbox.
- **TURN over TCP when UDP is fully blocked:** open (finding 3); next step TURNS:443 with a production provider.
- **Session-end media exposure (~50–56 s against a hostile client):** needs platform P1 (session-bound presence).
- **Chat and reaction rate limits:** none yet; better as platform P3 than as more app counters.
- **Capacity on real devices:** run `scripts/capacity.mjs` per device class; this host measures 3.
- **TURN credential scope:** relay credentials are valid for 4 h for whoever holds them; shorter TTL with
  renewal (`RTCPeerConnection.setConfiguration`) narrows reuse.

---

# Phase 3.1 (closure)

See [PHASE-3.1-CLOSURE.md](PHASE-3.1-CLOSURE.md) for the disposition and evidence, and
[PHASE-3.1-GAPS.md](PHASE-3.1-GAPS.md) for every gap's state (implemented, tested, pushed, merged, published,
verified by the consuming application). Phase 3 figures above are superseded where those documents say so:
session-end termination (now ~0.25 s on the unpublished FeltKit contract), the FeltKit suite (clean), and the
measurement (recorded with an exact tool commit).
