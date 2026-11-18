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
    member: ["meetings.*", "chat.*", "captions.*", "notes.*", "signal.*", "notifications.*", "feltkit.agent.*"],
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

/** A connected device (a person's browser tab) or an attending agent, in one call. */
export const peers = app.collection(
  "peers",
  {
    meetingId: s.ref("meetings"),
    callId: s.ref("calls"),
    principalId: s.string(),
    name: s.string({ minLength: 1, maxLength: 80 }),
    kind: s.enum(["person", "agent"] as const),
    joinedAt: s.number(),
    lastSeenAt: s.number(),
    leftAt: s.optional(s.number()),
    mic: s.boolean(),
    cam: s.boolean(),
    screen: s.boolean(),
    hand: s.boolean(),
  },
  { indexes: [{ fields: ["callId"] }, { fields: ["meetingId"] }] },
);

/** WebRTC signaling between two peers: one offer and one answer per pair, ICE included. Deleted once read. */
export const signals = app.collection(
  "signals",
  {
    meetingId: s.ref("meetings"),
    fromPeer: s.string(),
    toPeer: s.string(),
    kind: s.enum(["offer", "answer"] as const),
    sdp: s.string({ maxLength: 200_000 }),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["toPeer"] }] },
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
