/** Published shapes, derived from the collections (never restated). */
import { s } from "@feltdb/feltkit";
import { calls, entries, meetings, peers } from "./app.js";

export const MeetingOut = s.doc(meetings).omit("__version");
export const CallOut = s.doc(calls).omit("__version");
export const PeerOut = s.doc(peers).omit("__version", "meetingId");
export const EntryOut = s.doc(entries).omit("__version", "meetingId");

export function strip<T extends object>(r: T): T {
  const { __version, ...rest } = r as T & { __version?: unknown };
  return rest as T;
}
export function stripPeer<T extends object>(r: T): Omit<T, "meetingId"> {
  const { __version, meetingId, ...rest } = r as T & { __version?: unknown; meetingId?: unknown };
  return rest as Omit<T, "meetingId">;
}
export const stripEntry = stripPeer;
