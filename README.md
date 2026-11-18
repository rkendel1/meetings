# meetings

Video meetings in the browser that **people and agents attend together**, built with
[FeltKit](https://www.npmjs.com/package/@feltdb/feltkit) (`npm create feltkit@latest meetings`).
It is a FeltKit counterpart of [convex-meetings](https://github.com/saranatour1/convex-meetings)
(Convex + TanStack Start + Cloudflare RealtimeKit), rebuilt around one idea: an agent is a
first-class participant with its own identity and permissions, not a browser guest detected by name.

## What works

- **Meetings** with a short code (`abc-defg-hij`) and a link: `/m/<code>`. Access is *anyone signed in
  with the link* or *only the people and agents I invite*. Optional scheduled time.
- **Calls**: lobby with camera/mic preview and device pickers; video, audio, mute, camera on/off,
  **screen share** (stage layout), raise hand, six emoji reactions, several tabs/devices per person.
  The first person to join starts the call; it ends when the last *person* leaves (agents never keep a
  call open), or when the host ends it for everyone. The host can remove a connection.
- **Chat** and **live captions** (each person's browser transcribes its own speech with the Web
  Speech API, Chrome/Edge), kept in one ordered timeline per meeting.
- **Recaps** per call: start/end, attendance per person and agent (with devices and minutes), notes,
  reactions, and the full chat + transcript timeline. `/m/<code>/recap/<n>`.
- **Agents attend over MCP** (served at `/mcp`): `meetings_list`, `meetings_get`, `meetings_join`
  (presence, shown as an *AI agent* tile), `meetings_feed` (follow chat and captions with a cursor),
  `chat_send`, `chat_react`, `notes_add` (summary/action items into the recap), `meetings_recap`,
  `meetings_leave`. Agents carry no media; they read what was said as text.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open the App URL it prints. In development you are signed in as a dev user (Ada, Grace, Alan; switch in
the header). The session is a cookie, so to be two people at once use two browser profiles or a private
window. Production uses built-in e-mail/password accounts (`auth.accounts` in `feltkit/app.ts`).

### Bring an agent into a call

In the project folder, give the agent an identity (prints a token; the `agent` role is defined in
`feltkit/app.ts`):

```bash
npx feltkit session create --type agent --id claude --role agent --name Claude
```

Connect it over MCP (Claude Code shown; any MCP client works):

```bash
claude mcp add --transport http meetings http://localhost:3000/mcp --header "Authorization: Bearer <token>"
```

Then ask it: *"Join meeting abc-defg-hij with meetings_join, follow meetings_feed, answer in chat, and add
a summary with notes_add when we wrap up. Call meetings_join every 20 seconds to stay present."* The
call's **Agents** tab shows the same steps with the current code. For an invite-only meeting, the host
invites the agent's id (`claude`). In production, issue an API key (Studio → Services → API keys);
keys hold the `agent` role.

## How it is built

| Path | What it is |
|---|---|
| `feltkit/app.ts` | Roles (`member`, `agent`, `admin`), dev users, services, and the collections: `meetings`, `calls`, `peers`, `signals`, `entries` |
| `feltkit/_meeting.ts` | Meeting rules: access, liveness (45 s without a check-in = gone), settling a call, the per-meeting timeline sequence |
| `feltkit/meetings.ts` | `list`, `create`, `update`, `get`, `feed`, `recap` |
| `feltkit/calls.ts` | `join`, `heartbeat`, `leave`, `end` (host) |
| `feltkit/chat.ts` | `send`, `react`, `caption`, `note` |
| `feltkit/signals.ts` | WebRTC signaling: `send`, `inbox` (live), `ack` |
| `src/rtc.ts` | The browser media mesh |
| `src/Call.tsx`, `src/Recap.tsx`, `src/Home.tsx` | Screens |
| `tests/meetings.test.ts` | Backend tests (people, agents, access, host controls, durability across restart) |
| `scripts/e2e.mjs` | Browser test against a running dev server: two people with fake cameras + an agent over MCP |

**State.** Everything durable is in the app's one FeltDB instance: meetings, calls, who attended and
when, chat, captions, notes, reactions. Liveness is a `lastSeenAt` each connection refreshes every 15 s;
a call is settled (stale connections marked left at their last check-in, the call ended at the last
person's) by the next join, leave or check-in, so no background scheduler is needed and end times are
accurate.

**Media.** Audio and video go browser to browser over WebRTC, in a full mesh. FeltDB carries only the
signaling: each pair exchanges one offer and one answer (ICE gathered up front), and the smaller peer id
always offers, so there are no negotiation races. Each connection has one audio and one video
transceiver from the start; camera off and screen share swap the outgoing track without renegotiating.
STUN defaults to Google's public server; set `VITE_ICE_SERVERS` (JSON `RTCIceServer[]`) for your own
STUN/TURN.

**Authority.** Roles decide every call on every interface (app, AppPort, MCP). People (`member`) create
meetings, join with media, caption, chat. Agents (`agent`) may read meetings they are allowed into,
attend, chat, react and add notes; they cannot create or host meetings, caption, or send media
signaling. Per-meeting access (link vs. invited) is checked in every function.

## Tests

```bash
npm test
```

```bash
AGENT_TOKEN=<token from feltkit session create> node scripts/e2e.mjs http://localhost:3000
```

The e2e script needs `npm run dev` running and Playwright with Chromium installed.

## Not built (compared with convex-meetings)

Organizations and custom roles, e-mail invites with `.ics`, Google/GitHub sign-in and passkeys,
recording to object storage, a waiting room / join requests, ringing, public drop-in rooms with AI
moderation, shared-screen annotations and whiteboard, usage caps. Media is a mesh, which suits small
calls (each person uploads to every other); larger calls need an SFU (the change is confined to
`src/rtc.ts` and `feltkit/signals.ts`). Peers behind strict NATs need a TURN server.

## Deploying

FeltKit doesn't host your app; it builds what you run, for the way you want to run it:

| Target | What runs | Data |
|---|---|---|
| `container` (default) | Everything in one container | FeltDB state on a volume |
| `hosted` | A separate app container | Managed FeltDB, hosted for you, from the artifact's contract (it declares AppPort Services' collections too) |
| `self-hosted` | A separate app container | A FeltDB server you operate (`feltdb-server`), in this app's namespace |
| `vercel` | Vercel's container runtime (beta), scaling with traffic | Managed FeltDB, or your FeltDB server with `--data self-hosted` |

Each target's `DEPLOY.md` spells out its contract: what to set, where state lives and how to
recover it, what stops startup, and how to upgrade and roll back. A target never changes where
state is stored: the container target refuses `FELTDB_URL`, and the others refuse to start
without their FeltDB settings.

1. **Check what production needs.**

   ```bash
   npx feltkit readiness --env production
   ```

2. **Build and verify.** It asks which target (or pass `--target container`, `hosted`, `self-hosted` or `vercel`):

   ```bash
   npm run deploy
   ```

   This builds the backend and frontend, boots the production build against throwaway state
   to prove it serves, and writes `.feltkit/deploy/` with a `Dockerfile`, `docker-compose.yml`,
   `fly.toml`, `.env.example` (exactly the variables it needs) and `DEPLOY.md`. Each deploy
   replaces it, keeping production state a previous run kept inside it. It prints the commands
   to run next.

3. **Run it.** Everything in one container:

   ```bash
   docker compose -f .feltkit/deploy/docker-compose.yml up --build
   ```

   Or with Node, from the artifact (data in its `.feltkit/production`):

   ```bash
   cd .feltkit/deploy
   ```

   ```bash
   npm ci --omit=dev
   ```

   ```bash
   npm start
   ```

   With Managed FeltDB (`--target hosted`), create the app and its key from the artifact's
   contract (`npx feltdb init-managed --contract .feltkit/deploy/feltdb.contract.json
   --runtime-scopes minimal`), put `FELTDB_URL`, `FELTDB_APPLICATION_ID` and `FELTDB_TOKEN` in
   `.feltkit/deploy/.env`, then run the same `docker compose` command. With your own FeltDB
   server (`--target self-hosted`), create a key for the app's namespace (`feltdb-server keys
   create --keys <keys.json> --name meetings --namespace meetings --scope state:read,state:write`) and
   put `FELTDB_URL` and `FELTDB_TOKEN` in `.env`. On Vercel (`--target vercel`), create the app in
   Managed FeltDB (`npx feltdb init-managed --contract .feltkit/deploy/feltdb.contract.json
   --runtime-scopes minimal`, which writes `.env.local`), then run `npx feltkit vercel deploy`. It links
   the Vercel project the first time, uploads only the settings the deployment needs, deploys, and
   signs you in: it prints the app's URL, your session token, and a one-time link to production
   Studio. On Cloudflare (`--target cloudflare`), the same with `npx feltkit cloudflare deploy`
   (Docker must be running: wrangler builds the image locally). Either container refuses to start without its
   settings, and checks the database answers, so it never keeps data on its own disk. For
   Fly.io, plain Docker, or other hosts, follow `.feltkit/deploy/DEPLOY.md`.

   Open <http://localhost:3000>.

4. **Sign in.** Production has no development sign-in (Ada and Grace are for development). The
   app has built-in accounts (`auth: { accounts: { roles: ["member"] } }` in `feltkit/app.ts`):
   open it and create your account with an e-mail address and a password; anyone you share the
   link with can do the same, and a new account is a member. Passwords are stored only as a
   scrypt hash, in the app's own FeltDB. To close sign-up once your people have accounts, set
   `signUp: false`. To give someone admin, or to use your own login instead, see
   `auth.authenticate` and production Studio below.

   The sign-in screen grows with configuration: add `email: { from: "auth@yourdomain" }` to
   `auth.accounts` for "Forgot your password?" and address verification (development prints each
   e-mail; production sends through your Mailerport service, `MAILPORT_URL` and
   `MAILPORT_API_KEY`), and `auth.providers` for "Continue with Google / GitHub" (client id in
   `feltkit/app.ts`, client secret as `FELTKIT_CREDENTIAL_<ID>_CLIENT_SECRET`).

   **On AppBoundry** (`npx feltkit build --target appboundry`, then
   `npx @appport/appboundry@^1.3.0 run meetings.app`; to test the artifact itself, use
   `createArtifactTestApp("meetings.app")` from `@feltdb/feltkit/testing`), AppBoundry's operators
   create users with your app's roles and issue their sessions:

   ```bash
   appboundry admin users add you --role member --state <installation>
   appboundry admin sessions issue --user you --state <installation>
   ```

   See AppBoundry's production operations guide for bootstrapping the first operator.

   Operators and scripts can still get a session token without an account:
   `npx feltkit session create --env production --type user --id <id> --role <role>` in the
   project's folder (it uses the deployment's FeltDB settings from `.env.local`). For the
   one-container Docker run, use a one-off container on the same volume while the app's container
   is stopped:

   ```bash
   docker run --rm -v meetings-data:/data meetings node node_modules/@feltdb/feltkit/bin/feltkit.js session create --env production --type user --id you --role member
   ```

5. **Manage it.** On Vercel, production Studio is on (at `/_feltkit/` of your app). Run
   `npx feltkit manage` for a one-time sign-in link, or use **Manage in production Studio** on
   the Settings page of your local Studio (`npm run dev`), which also shows where production's data
   is and links to the live app.

**Production settings** (from your secret manager, never in the repository). With one
container, none is required:

| Variable | What it's for |
|---|---|
| `FELTDB_URL`, `FELTDB_APPLICATION_ID`, `FELTDB_TOKEN` | Managed FeltDB (`--target hosted`) |
| `FELTDB_URL`, `FELTDB_TOKEN` | Your FeltDB server (`--target self-hosted`) |
| `FELTKIT_WEBHOOK_PRIVATE_NETWORKS` | `1` lets webhooks reach receivers on private networks (refused by default outside development) |
| `FELTKIT_API_KEY_VERIFIER_KEY` | Hosted and self-hosted: 32+ random bytes (`openssl rand -base64 32`). In one container it is generated once and kept beside the state on the volume |
| `FELTKIT_CREDENTIAL_<ID>` | Credential values, e.g. `FELTKIT_CREDENTIAL_ANTHROPIC` for `credential-ref:anthropic`. Keys you entered in Studio are development-only and are not deployed |
| `FELTKIT_STATE_DIR` | Where local state lives (the container image uses `/data/state`, on the volume) |
| `FELTKIT_OPERATOR_KEY` | Optional: signs operator sign-ins for production Studio |
| `FELTKIT_PORT`, `PORT` | The port to listen on, exactly (`--port` wins over both, `FELTKIT_PORT` over `PORT`). Unset: the first free port from 3000 |

**Production Studio.** Studio isn't served in production unless `FELTKIT_DASHBOARD=1`. Then
operators sign in with a one-time grant you create on the host
(`npx feltkit operator grant --id <id> --role <role> --env production`). Production Studio
is for operating the app; data edits and service configuration stay development tools.
To move non-secret configuration between environments, use
`npx feltkit config export` and `npx feltkit config import <file> --env production --dry-run`.

To deploy on Managed FeltDB, where no host keeps state, start from
`npm create feltkit@latest <dir> -- --template managed`; its README walks through setup.

## Portability (AppBoundry)

`npx feltkit build --target appboundry` compiles the app into `meetings.app`, which runs without
this project or FeltKit. A plain `npx feltkit build` warns about anything that would block it.
An artifact refuses (the build names the file and line):

- `ctx.agent`, `ctx.unsafe`, `ctx.afterCommit`, `ctx.db.sequence`: they need the FeltKit server;
- `app.integration(...)` and `auth.authenticate`;
- Node built-ins in `feltkit/`;
- `Intl`, `toLocaleString`, `localeCompare`: the artifact has no locale data, so format for
  people in the frontend.

It also leaves out Studio, `/mcp`, API keys, schedules and webhook delivery. To run your tests
against the artifact itself: `createArtifactTestApp("meetings.app")` from `@feltdb/feltkit/testing`.

## Commands

npm scripts:

| Script | Runs |
|---|---|
| `npm run dev` | `feltkit dev`: backend, frontend, Studio and hot reload |
| `npm test` | `feltkit test`: the tests, against isolated test environments |
| `npm run build` | `feltkit build`: bundle the backend, build the frontend, verify the bundle |
| `npm start` | `feltkit start`: run the production build |
| `npm run deploy` | `feltkit deploy`: build a verified deployment artifact |
| `npm run inspect` | `feltkit inspect`: status, state location, functions, services, recent activity |
| `npm run typecheck` | `tsc --noEmit` |

Every `feltkit` command (run as `npx feltkit <command>`; `--help` on any of them for its options):

| Command | What it does |
|---|---|
| `dev [--port 3000]` | Development environment: backend, frontend, Studio, hot reload |
| `build` | Bundle the backend, build the frontend, load the bundle to verify it |
| `start [--port $PORT]` | Run the production build (the `production` environment) |
| `test [files…]` | Run `tests/**/*.test.ts` against isolated test environments |
| `deploy [--out <dir>]` | Build, verify the production build boots, write a Node/Docker artifact |
| `inspect [--json]` | What the app is, where its state lives, and what it's doing |
| `readiness [--env production]` | What an environment has and lacks before production, with fixes |
| `model show` / `model set` | Show or choose the model that makes agent decisions |
| `credential set` / `status` / `remove` | Store an API key (from a hidden prompt or stdin, never an argument), see where each credential comes from, or erase one |
| `config export` / `import` | Move non-secret configuration (variables, webhook endpoints, …) between environments |
| `session create` / `list` / `revoke` | Sessions for agents and service accounts |
| `operator grant` | A one-time production Studio sign-in for an operator |
| `codegen` | Regenerate `feltkit/_generated/api.ts` |
| `contract` | Write the FeltDB application contract (Managed FeltDB) |
| `doctor` | Check Node, dependencies and running servers for problems |
| `skills install` / `check` | Add or validate the FeltKit skills for coding agents (Claude Code) |

## Using a coding agent

```bash
npx feltkit skills install
```

adds the FeltKit skills to `.claude/skills/`, so Claude Code knows how to build, test and
operate this app.

## When something's wrong

- `npx feltkit doctor` checks Node, dependencies and running servers.
- `npx feltkit inspect` shows the environment's state, functions and recent errors.
- Studio → **Activity** shows every operation: who ran it, what was decided, and what FeltDB
  committed.
- Errors carry a code (`FORBIDDEN`, `INVALID_ARGUMENT`, `NOT_FOUND`, …) and usually a hint with
  the fix.

FeltKit documentation ships with the package: `npx feltkit docs` lists it (guarantees, transactions,
security, agents, path to production, backup) and `npx feltkit docs <name>` prints one. The same files
are in `node_modules/@feltdb/feltkit/docs/`, and online at
<https://cdn.jsdelivr.net/npm/@feltdb/feltkit/docs/README.md>.
