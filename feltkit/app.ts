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

export const app = feltkit({
  name: "meetings",
  description: "Video meetings that people and agents attend together: chat, reactions, live captions, recaps.",
  roles: {
    // People: create meetings, join calls (media + signaling), chat, captions, notes.
    member: ["meetings.*", "chat.*", "captions.*", "notes.*", "signal.*", "media.*", "notifications.*", "feltkit.agent.*"],
    // Agents: see meetings they may attend, attend (presence only, no media), read the timeline,
    // chat, react, and leave notes for the recap. They cannot create meetings, host, or caption.
    agent: ["meetings.read", "meetings.attend", "chat.*", "notes.*", "feltkit.agent.*"],
    // Admins configure the app in Studio → Services: the model, credentials, configuration, API keys.
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "feltkit.operations.*"],
  },
  // People sign up and sign in with an e-mail address and a password. A new account is a member.
  auth: { accounts: { roles: ["member"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["member"] },
      { id: "alan", name: "Alan Turing", roles: ["member"] },
    ],
  },
  services: {
    notifications: { types: ["meeting.invited"] },
    configuration: true,
    // An API key holds the agent role: that is how an agent outside this machine attends.
    apiKeys: { roles: ["agent"] },
    intelligence: true,
  },
});

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
    scheduledFor: s.optional(s.number()),
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
  },
  { unique: [["meetingId", "number"]], indexes: [{ fields: ["meetingId"] }] },
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
    kind: s.enum(["chat", "caption", "reaction", "note", "system"] as const),
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
