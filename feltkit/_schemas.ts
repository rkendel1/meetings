/** Published shapes, derived from the collections (never restated). */
import { s } from "@feltdb/feltkit";
import { calls, entries, meetings } from "./app.js";
import { peers } from "./_presence.js";
import { actionItems, decisions, summaries } from "./_records.js";

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

export const ActionOut = s.doc(actionItems).omit("__version");
export const DecisionOut = s.doc(decisions).omit("__version");
export const SummaryOut = s.doc(summaries).omit("__version");
