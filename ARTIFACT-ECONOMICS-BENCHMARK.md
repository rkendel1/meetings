# Meetings: artifact-first deployment and operational economics benchmark

Date: 2026-11-19. Application: `rkendel1/meetings` at `685a7d4` (branch `claude/gallant-cannon-k8j6e9`).
Platform: `@feltdb/feltkit` **0.3.32 as published on npm** (`latest`), `@appport/appboundry` **1.13.0** (`latest`).
No locally patched FeltKit was used for any measurement below.

## Verdict first

**The equivalent comparison could not be run. Meetings cannot be built into an AppBoundry `.app` artifact.**
`feltkit build --target appboundry` refuses it (exit 1, full output in
[`docs/bench/appboundry-build-refusal.txt`](docs/bench/appboundry-build-refusal.txt)):

```
✗ This application uses FeltKit features an AppBoundry artifact cannot provide:
  feltkit/media.ts:26: app.action runs in the FeltKit server ...; an artifact runs transactions only.
  app.integration("turn"): integrations call external HTTP APIs, and an artifact has no network access.
  hint: ... The artifact would behave differently from your application, so nothing was built.
```

Even if those two were removed, an artifact of this app would also lose things the build does not refuse but
silently omits or does not serve: the `/mcp` endpoint (agents cannot join, which is half the product), API
keys, and built-in sign-up/sign-in (artifacts accept operator-issued sessions only, FK-GAP-013). The managed
AppBoundry service answers `NO_EXECUTION_CAPACITY` (`untrusted_execution_disabled`) and offers no public
routing (recorded in FeltKit's `docs/APPBOUNDRY.md`, rkendel1/feltkit; not re-observed in this benchmark).

Removing TURN credential issuing, agents and self-service identity to make the build pass would change the
application's architecture to suit the benchmark, which the brief forbids. So:

- The **conventional** side was fully measured (all 7 workloads, from the deployment artifact
  `feltkit deploy --target container` generates).
- The **AppBoundry** side was measured only where it can be measured honestly: the **runtime's own idle
  footprint**, serving the same FeltKit starter app that both runtimes can serve. That is labeled **not
  Meetings** everywhere it appears.
- **No AppBoundry cost was computed.** There is no published AppBoundry price and no managed capacity to
  measure. Nothing here assumes AppBoundry scales to zero; the observation is that the self-hosted runtime is
  itself an always-on process.

**Release status is unchanged by this benchmark.** The session-bound presence/media termination gap (G2 in
[`PHASE-3.1-GAPS.md`](PHASE-3.1-GAPS.md)) remains a release blocker: the fix depends on FeltKit `7276b21`,
which is unmerged and unpublished. All numbers below were taken on published 0.3.32, i.e. *with* that gap.

## 1. What was deployed

```
                CONVENTIONAL (measured)                              APPBOUNDRY (refused for Meetings)
 browsers ──HTTPS/WS──► counting proxy ──► feltkit start (Node)       browsers ──► appboundry run app.app
   │  ▲                     :3100           ├─ HTTP/WS, auth, live      │             ├─ transactions only
   │  │ WebRTC media                        ├─ functions + actions      │             ├─ no actions, no network
   ▼  │ (peer to peer,                      ├─ /mcp (agents)            ▼             ├─ no /mcp, no API keys
 browsers   never via server)               ├─ services worker        (no TURN issuing, ├─ operator sessions only
                                            └─ FeltDB (local state)    no agents)       └─ FeltDB state (local)
   TURN relay (Cloudflare) ◄─ credentials issued by media:iceServers (app.integration("turn"))
```

The server carries signaling, presence, chat and identity; **media never passes through it** (WebRTC mesh).
Media cost lands on clients' uplinks, or on the TURN provider for the share of participants who need a relay.

### Conventional deployment, exact steps

1. `npx feltkit deploy --target container` (published 0.3.32) → `.feltkit/deploy/` (Dockerfile, built
   functions, client bundle, lockfile pinning `@feltdb/feltkit@0.3.32`).
2. The Docker image build **failed in this sandbox** (`npm` inside the container cannot trust the sandbox's
   TLS proxy: "Exit handler never called"). This is an environment limit, not an app or FeltKit defect. The
   same artifact was therefore run by its documented non-container path, with the image's own environment:
   ```
   cd .feltkit/deploy && npm ci
   env -u FELTDB_URL -u FELTDB_TOKEN FELTKIT_STORAGE=local FELTKIT_STATE_DIR=<state> \
       FELTKIT_PORT=3100 NODE_ENV=production node node_modules/@feltdb/feltkit/bin/feltkit.js start
   ```
   Container overhead (runtime, image storage) is therefore **not** in the measurements.
3. Correctness on this deployment: `scripts/e2e-identity.mjs` passed against it (production mode, real
   sign-up). The full Playwright suite uses development users and was run on the development server from the
   same source, not on this deployment; the workload harness itself exercises sign-up, meeting creation, joins,
   P2P media and crash recovery on the deployment.

### AppBoundry side, exact steps

1. `npx feltkit build --target appboundry` in Meetings → refused (above).
2. Runtime probe: `npm create feltkit@0.3.32 starter` (template *tasks*, unmodified), `npx feltkit build
   --target appboundry` → `starter.app` (4.3 MiB; manifest sha256 `53c6e305…85982`, module sha256
   `95fc073b…fbacf`; full digests in [`docs/bench/runtime-idle-starter.json`](docs/bench/runtime-idle-starter.json)).
3. `npx -y @appport/appboundry@1.13.0 run starter.app --state <dir> --accounts operator-sessions` (reported
   limits: 5,000 ms/step, 30,000 ms/call, 8 instances × 256 MiB; host access: network none, filesystem none).
4. For comparison the same starter app was served with `feltkit start` (production, local state).

## 2. Environment

| | |
|---|---|
| Host | 4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GiB RAM, Linux 6.18.44 (sandbox VM, shared tenancy unknown) |
| Node | v22.23.5 |
| Clients | Chromium (Playwright) **on the same host**, fake 640×480 camera and microphone |
| Network | loopback; no real WAN, NAT or loss. **Nothing here is real-world interoperability evidence** (G6) |
| Instrumentation | `/proc/<pid>/stat` utime+stime ÷ CLK_TCK; VmRSS sampled 1/s; a byte-counting TCP proxy in front of the server for app traffic; `du` of the FeltDB state directory; `RTCPeerConnection.getStats()` for media |

Because clients share the host, they compete with the server for CPU. Server CPU is attributed by PID, so it is
the server's own time, but absolute latencies (connect times, recovery) include that contention.

## 3. Workloads and results (conventional, observed)

Harness: [`scripts/bench/run-workloads.mjs`](scripts/bench/run-workloads.mjs); idle sampler:
[`scripts/bench/idle-measure.sh`](scripts/bench/idle-measure.sh); raw results:
[`docs/bench/conventional-results.json`](docs/bench/conventional-results.json) (schema `meetings.bench/1`,
every value tagged observed/calculated) and [`docs/bench/conventional-recovery.json`](docs/bench/conventional-recovery.json).

| Workload | Definition | Wall | Server CPU-s | RSS avg / peak MiB | App traffic in / out | P2P media | State Δ | Notes |
|---|---|---|---|---|---|---|---|---|
| idle | server up, no clients | 600 s | **1.53** (0.0025 cores) | 88.8 / 107.7 | 0 / 0 | — | 0 | measured, not assumed |
| light | 3 users sign in, browse, no meeting | 181 s | 0.67 | 145 (peak) | 22 KiB / 912 KiB | — | small | |
| small | 1 meeting × 2 people, 3 min | 184 s | 1.00 | — | — | 31.5 MB | +242 KB | 6 participant-min; connected in 2,782 ms |
| normal | 1 meeting × 4 people, 3 min | 185 s | 2.29 | — | 674 / 2,357 KiB | 79.7 MB | +665 KB | 12 participant-min |
| busy | 3 concurrent meetings × 2 people | 191 s | 2.17 | — | 528 / 2,463 KiB | 89.5 MB | +727 KB | 18 participant-min |
| burst | 4 meetings created and joined at once | 49 s | 1.40 | — | — | — | — | 4/4 completed |
| recovery | SIGKILL during a 2-person meeting, restart | — | restart 0.82 | — | — | — | — | old pid gone 1,706 ms; healthy 2,139 ms; both participants checked in again 12,397 ms after the kill |

Cold start: 2,263 ms on a fresh state directory, 423 ms warm. Peak RSS across all scenarios: 183.6 MiB.

**Recovery note.** The first recovery run was invalid and was discarded (the restart was issued before the
killed process had exited; FeltKit correctly refused a second writer, "production environment is already
running", and the sampler then read PID 0). The harness was fixed to wait for exit and use a PID file, the run
was repeated, and the discard is recorded in the results file. The 12.4 s re-check-in is bounded by the
client's heartbeat interval and reconnect backoff, not by the server.

**Scale caveat.** All browsers ran on one 4-vCPU host; the busiest run had 4 concurrent browsers. This is not a
capacity measurement and no capacity claim is made from it (G9).

### Unit consumption derived from the runs (calculated)

| per participant-minute | small (2p) | normal (4p) | busy (3×2p) |
|---|---|---|---|
| server CPU-s | 0.167 | 0.191 | 0.121 |
| app traffic (in+out) KiB | 161 | 253 | 166 |
| state directory growth KiB | 39 | 54 | 39 |
| P2P media MiB (not via server) | 5.0 | 6.3 | 4.7 |

**Finding: state grows ~40–54 KiB per participant-minute** (heartbeats, signaling and presence writes). This
is the on-disk FeltDB state directory, which may include log segments not yet compacted; retention was not
verified. Projected over 2,000 meeting-hours/month it would be ~25 GiB/month. It is the one consumption figure
that grows without bound with use, and it deserves a retention/compaction check before any sizing decision.

### AppBoundry runtime vs FeltKit runtime, idle (starter app, **not Meetings**)

| Runtime (120 s idle, no clients) | CPU-s | RSS avg MiB | Ready |
|---|---|---|---|
| `appboundry run` 1.13.0, runtime process | 0.08 | 135.6 | 5,093 ms (incl. npx resolution) |
| same, whole tree incl. npx launcher | 0.21 | 318.7 | |
| `feltkit start` 0.3.32 | 0.49 | 90.1 (peak 117.7) | |

Both are always-on processes. Neither scaled to zero. Neither idles at zero memory.

## 4. Cost model

Script: [`scripts/bench/cost-model.mjs`](scripts/bench/cost-model.mjs) → [`docs/bench/cost-model.json`](docs/bench/cost-model.json).
Every rate is a parameter at the top of the script (or `RATES_JSON=<file>`); re-running recomputes everything.

### Rates and their status

| Rate | Value | Status |
|---|---|---|
| VM, 2 vCPU shared / 4 GiB class | €3.79–€5.49/month excl. VAT | **Estimate, unverified**: third-party aggregators for Hetzner CX22/CX23; Hetzner's own page was not reached. Replace before use |
| TURN relay | $0.05/GB egress to client, first 1,000 GB/month free (shared with SFU) | **Published**: Cloudflare Realtime TURN docs |
| Hours per month | 730 | convention |
| AppBoundry | — | **Unavailable**: no published price, no managed capacity. Not estimated |

### Cost categories (conventional)

| Category | What it is here | How it behaves |
|---|---|---|
| Fixed | one always-on VM | €3.79–€5.49/month regardless of use |
| Variable | server CPU, app traffic | observed ~0.19 CPU-s and ~250 KiB per participant-minute; absorbed by the fixed VM at every projected volume |
| Shared | VM, DNS/TLS, backups if colocated with other apps | **not free**; allocate by share. Not measured here |
| Per meeting / per participant | signaling, presence, state writes | see units above |
| Network relay | TURN bytes for participants that cannot connect P2P | parameter (relay share); P2P media itself costs the server nothing |
| Storage | FeltDB state | grows ~54 KiB/participant-minute (unverified retention) |
| Operations | patching, TLS, backups, monitoring, restarts | not measured; see §5 |

### Derived figures (conventional; estimates because the VM rate is an estimate)

| Metric | Value |
|---|---|
| per application-hour | €0.0052–€0.0075 |
| idle 24 h | €0.12–€0.18 (observed utilisation during idle: 0.25% of one core, 89 MiB) |
| marginal server CPU of a 4-person meeting-hour | 45.8 CPU-s (observed rate × 240 participant-minutes) |
| per active meeting-hour / participant-hour | instance cost ÷ hours carried; see projections. At these volumes the marginal compute cost is negligible against the fixed instance |

| Monthly projection (stated workloads, 4 people per meeting) | Participant-min | Server CPU of 2 vCPU | € per 1,000 participant-min | State growth | TURN if 20% relayed | TURN if 100% relayed |
|---|---|---|---|---|---|---|
| W0 idle all month | 0 | 0.13% | — (€3.79–5.49 for nothing) | 0 | $0 | $0 |
| W1 20 meeting-hours | 4,800 | 0.15% | 0.79–1.14 | 0.25 GiB | 5.9 GB → $0 | 29.7 GB → $0 |
| W2 200 meeting-hours | 48,000 | 0.30% | 0.08–0.11 | 2.5 GiB | 59 GB → $0 | 297 GB → $0 |
| W3 2,000 meeting-hours | 480,000 | 1.87% | 0.008–0.011 | 25 GiB | 593 GB → $0 | 2,967 GB → **$98** |

Relay share is a parameter, not an observation (this benchmark and the network lab needed no relay). Media per
participant-minute was observed with fake 640×480 video; real cameras will usually send more, so relay figures
are a lower bound. CPU utilisation is a ratio of observed CPU time, **not** a statement that one VM can carry
2,000 meeting-hours: concurrency, socket counts and real-device behaviour were not measured.

**Reading of the model:** the conventional deployment's cost is almost entirely the fixed instance (plus TURN,
only at large relayed volume). The idle cost is real and small, and it is the same instance cost as the
busy cost. The variable cost a scale-to-zero platform could save is the idle €3.79–5.49/month, minus whatever
that platform charges; that cannot be priced today.

## 5. Operational ownership

| Concern | Conventional (`feltkit start` on a VM) | AppBoundry artifact |
|---|---|---|
| Runs Meetings as built | **Yes** | **No** (build refused) |
| Agents over MCP | yes | omitted |
| Self-service sign-up/in | yes | operator-issued sessions only |
| TURN credential issuing | yes (integration + action) | refused |
| Who owns the host, OS patches, TLS, DNS | the operator | self-hosted: the operator (same); managed: the service, which has no capacity today |
| Process supervision / restart | operator (systemd/container); recovery measured: healthy in 2.1 s | self-hosted: operator; managed: service (unobserved) |
| State custody and backup | operator, local FeltDB directory (or remote FeltDB) | runtime's `--state` directory, operator-owned when self-hosted |
| Isolation of app code | process-level; the app's actions can reach the network | strong: no network, no filesystem, per-step limits (observed in the run banner) |
| Provenance | deploy lockfile pins FeltKit 0.3.32; app commit `685a7d4` | manifest + module digests (starter only) |
| Idle footprint | 89 MiB, 0.25% core (Meetings) | 136 MiB runtime process, 0.07% core (starter) |

The artifact model's real advantage is isolation and a sealed, digestible unit of deployment. Its cost is
capability: everything in Meetings that talks to the outside world or to agents is outside what an artifact
may do.

## 6. Acceptance against both

- **Conventional:** `e2e-identity` passed against the production deployment; the workloads above ran on it
  successfully (sign-up, meetings, 2- and 4-person media, concurrent meetings, burst, crash recovery). The
  session-termination tests (`tests/session-bound.test.ts`) **fail on published 0.3.32**, as recorded in
  Phase 3.1; that is the release blocker, not a benchmark artifact.
- **AppBoundry:** not runnable; there is no artifact to accept.

## 7. Limitations and unmeasured costs

- No container runtime overhead (image build blocked by the sandbox's TLS proxy).
- Clients on the same host as the server; no real network, NAT, loss or devices.
- Short runs (3 min per meeting workload; 10 min idle); no day-long soak.
- Operations labour, monitoring, backups, TLS/DNS and shared-infrastructure allocation are named, not measured.
- VM price unverified; AppBoundry price nonexistent.
- State growth retention/compaction not verified.
- The AppBoundry idle comparison uses a different (starter) app; it measures the runtime, not Meetings.

## 8. The decision questions

1. **Can Meetings run from a sealed AppBoundry artifact?** No. The build refuses it (actions, TURN
   integration); agents, API keys and self-service accounts would also be lost. Evidence: §Verdict.
2. **Does artifact deployment remove idle cost?** Not demonstrated. The self-hosted runtime is an always-on
   process (136 MiB idle). Managed AppBoundry has no execution capacity, so scale-to-zero cannot be observed.
3. **What does the conventional deployment cost idle?** One instance: €0.12–0.18/day (estimate), with observed
   utilisation of 0.25% of a core and 89 MiB.
4. **What does an active meeting cost?** Marginally ~0.19 server CPU-s and ~250 KiB of app traffic per
   participant-minute, ~54 KiB of state; media is peer to peer and costs the server nothing. Per 1,000
   participant-minutes: €0.008–1.14 depending on monthly volume (the fixed instance amortised).
5. **What dominates cost?** The fixed instance, at every projected volume. TURN only at large volume and high
   relay share (W3, 100%: ~$98/month). State storage is the one unbounded growth term.
6. **Where would AppBoundry be cheaper?** Only for idle or very low volume, and only if a managed service
   existed that charges less than ~€4–5.50/month and actually releases resources at idle. Neither is true or
   observable today.
7. **How do performance and recovery compare?** Conventional: cold start 0.4–2.3 s, healthy 2.1 s after a
   SIGKILL, participants back 12.4 s after it. AppBoundry: ready in ~5.1 s (starter, including npx); Meetings
   not runnable.
8. **What operational ownership changes?** Self-hosted AppBoundry changes little (the operator still owns the
   host, process and state) and adds strong isolation. Managed AppBoundry would move host ownership to the
   service, but it cannot execute today.
9. **What would make the comparison possible?** Either AppBoundry gains actions/integrations (or an
   equivalent for TURN credential issuing), MCP and built-in accounts, plus managed execution capacity and
   published pricing; or the owner explicitly authorises benchmarking a **non-equivalent** reduced variant
   (no TURN issuing, no agents, operator sessions), reported as such.
10. **Recommendation:** deploy Meetings conventionally (`feltkit deploy`) on a small always-on instance once
    the release blocker is cleared; do not pursue artifact deployment for this app now. Re-run this benchmark
    (`scripts/bench/*`, unchanged) when AppBoundry's capabilities or pricing change. **Release remains
    blocked** on G2 (FeltKit session-bound presence published and verified by this app).
