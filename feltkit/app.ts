/**
 * Meetings: video calls in the browser, with chat, reactions, live captions and recaps,
 * that people and agents attend together.
 *
 * Every meeting, call, attendee, chat line, caption and note lives in this app's one FeltDB
 * instance. Audio and video travel browser-to-browser (WebRTC); FeltDB carries only the
 * signaling that connects them. Agents never touch media: they attend through AppPort/MCP
 * and read the same timeline (chat + captions) people see.
 */
import { feltkit, s } from "@feltdb/feltkit";
import demo from "../demo.json";

export const app = feltkit({
  name: "meetings",
  description: "Video meetings that people and agents attend together: chat, reactions, live captions, recaps.",
  roles: {
    // People: create meetings, join calls (media + signaling), chat, captions, notes.
    member: ["meetings.*", "observations.*", "files.read", "files.write", "chat.*", "captions.*", "notes.*", "signal.*", "media.*", "notifications.*", "actions.*", "decisions.*", "summaries.*", "search.*", "recording.*", "ai.*", "feltkit.agent.*"],
    // Agents: see meetings they may attend, attend (presence only, no media), read the timeline,
    // chat, react, and leave notes for the recap. They cannot create meetings, host, or caption.
    // They also keep the meeting's records (action items, decisions, summaries) and research past meetings.
    agent: ["meetings.read", "meetings.attend", "observations.read", "files.read", "chat.*", "notes.*", "actions.*", "decisions.*", "summaries.*", "search.*", "notifications.read", "feltkit.agent.*"],
    // Admins configure the app in Studio → Services (the model, credentials, API keys) and here: branding,
    // retention, and the maintenance sweep a schedule runs.
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "settings.*", "maintenance.*", "notifications.send", "jobs.*", "schedules.*", "feltkit.operations.*"],
    // The application's own agents (feltkit/agents.ts): each holds only what its work needs, as its own principal.
    scribe: ["scribe.run", "notifications.send"],
    assistant: ["assistant.run"],
    janitor: ["janitor.run", "notifications.send"],
    // A read-only look at Studio for a public demo (see `auth.authenticate` below). It can read, never change.
    "studio-viewer": ["feltkit.operations.read"],
  },
  // People sign up and sign in with an e-mail address and a password. A new account is a member.
  auth: {
    accounts: { roles: ["member"] },
    // When a session ends (sign-out, revocation, expiry), FeltKit runs this as that session's principal, so
    // the connections it held end at once (session-bound presence; FeltKit 0.3.37).
    onSessionEnd: "calls:sessionEnded",
    // A PUBLIC DEMO ONLY (demo.json "openStudio", with Studio on: FELTKIT_DASHBOARD=1, which `feltkit fly deploy` sets):
    // Studio opens for anyone with no key, as a read-only viewer. Production Studio never serves data edits, function runs, capability calls or model changes
    // to any operator, and this role can read only. Everything else stays on the application's own sessions: the hook
    // answers nothing for any path but Studio's API, and nothing at all unless demo.json says so.
    authenticate: (request) =>
      demo.openStudio === true && request.method === "GET" && request.path.startsWith("/_feltkit/api/")
        ? { id: "demo-studio", type: "user", displayName: "Demo visitor (read-only)", roles: ["studio-viewer"] }
        : null,
  },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["member"] },
      { id: "alan", name: "Alan Turing", roles: ["member"] },
    ],
  },
  services: {
    notifications: { types: ["meeting.invited", "actionitem.assigned", "actionitem.due", "recap.ready"] },
    // The sweep (feltkit/maintenance.ts) ends calls nobody is writing to, sends due reminders and applies the
    // retention policy. An admin schedules it once: Studio → Services → Schedules, job type maintenance.sweep.
    jobs: { handlers: { "maintenance.sweep": "maintenance:sweep" } },
    schedules: true,
    configuration: true,
    // Observations (feltkit/observations.ts): a participant's screen captures, kept as the original bytes. files.read
    // and files.write in the roles above only let this app's own functions reach the bytes: FeltKit publishes no file
    // capability to callers, and observations.get authorizes each read against the meeting (mayReadRecords) first.
    files: true,
    // An API key holds the agent role: that is how an agent outside this machine attends.
    apiKeys: { roles: ["agent"] },
    intelligence: true,
  },
});

/** When housekeeping last ran (feltkit/agents.ts, the janitor): one record. */
export const housekeeping = app.collection("housekeeping", { key: s.string({ maxLength: 16 }), lastAt: s.number() }, { unique: [["key"]] });

/** A meeting: a stable room with a short code. Calls happen in it, one at a time. */
export const meetings = app.collection(
  "meetings",
  {
    code: s.string({ minLength: 12, maxLength: 12 }), // abc-defg-hij
    title: s.string({ minLength: 1, maxLength: 120 }),
    hostId: s.string(),
    hostName: s.string(),
    // link: anyone signed in who has the code (people or agents). invited: the host and the listed principal ids.
    access: s.enum(["link", "invited"] as const),
    invited: s.array(s.string()),
    // Which agents may attend: only those the host listed in `invited` (approved), or any agent holding the link (open).
    agents: s.optional(s.enum(["approved", "open"] as const)),
    scheduledFor: s.optional(s.number()),
    // The meeting this one continues, set by the host (never inferred): "what did we decide last time" reads it.
    previousMeetingId: s.optional(s.string()),
    createdAt: s.number(),
  },
  { unique: [["code"]], indexes: [{ fields: ["hostId"] }] },
);

/** One call in a meeting: starts when the first person joins, ends when the last person leaves. */
export const calls = app.collection(
  "calls",
  {
    meetingId: s.ref("meetings"),
    number: s.integer({ minimum: 1 }),
    startedAt: s.number(),
    endedAt: s.optional(s.number()),
    // True until the call ends: the maintenance sweep finds calls nobody is writing to without scanning history.
    open: s.optional(s.boolean()),
    // The latest recording of this call. Recording is the host's browser capturing the call (feltkit/recording.ts);
    // everyone sees that it is on, and the call keeps who started it and when.
    recording: s.optional(s.object({ by: s.string(), byName: s.string(), startedAt: s.number(), stoppedAt: s.optional(s.number()) })),
  },
  { unique: [["meetingId", "number"]], indexes: [{ fields: ["meetingId"] }, { fields: ["open"] }] },
);


/**
 * The meeting's timeline, in one order: chat, captions (what people said), reactions, notes
 * (agents' and people's notes for the recap) and joins/leaves. `seq` is per meeting.
 */
export const entries = app.collection(
  "entries",
  {
    meetingId: s.ref("meetings"),
    callId: s.optional(s.string()),
    seq: s.integer({ minimum: 1 }),
    kind: s.enum(["chat", "caption", "reaction", "note", "system", "observation"] as const),
    authorId: s.string(),
    authorName: s.string(),
    authorKind: s.enum(["person", "agent"] as const),
    text: s.string({ minLength: 1, maxLength: 4000 }),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["meetingId", "seq"] }, { fields: ["callId"] }] },
);

/**
 * TURN relay credentials, from a TURN provider's API (the shape of Cloudflare Realtime's
 * `POST /v1/turn/keys/{key}/credentials/generate-ice-servers`). The provider's API token stays in
 * FeltKit's credential custody (`credential-ref:turn`; in production `FELTKIT_CREDENTIAL_TURN`); the
 * browser only ever sees short-lived relay credentials, issued to people in a live call
 * (feltkit/media.ts). `TURN_API_URL` is the key's URL, e.g. https://rtc.live.cloudflare.com/v1/turn/keys/<id>.
 * Development: `node scripts/turn-api-dev.mjs` in front of a local coturn.
 */
const IceServer = s.object({ urls: s.union([s.string(), s.array(s.string())]), username: s.optional(s.string()), credential: s.optional(s.string()) });
export const turn = app.integration("turn", {
  description: "Short-lived TURN relay credentials for calls.",
  baseUrl: { env: "TURN_API_URL", development: "http://127.0.0.1:4790/v1/turn/keys/dev" },
  credential: "credential-ref:turn",
  timeoutMs: 5000,
  operations: {
    iceservers: {
      method: "POST",
      path: "/credentials/generate-ice-servers",
      input: { ttl: s.integer({ minimum: 60, maximum: 86_400 }) },
      output: s.object({ iceServers: s.union([IceServer, s.array(IceServer)]) }),
      effect: "observation",
      readOnly: true,
      access: "media.ice",
      expose: false, // only through media:iceServers, which checks the caller is in a live call
    },
  },
});
