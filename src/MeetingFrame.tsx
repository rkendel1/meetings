import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { navigate, retrying, when } from "./util";

/**
 * Around a meeting's page: what the server decided about the meeting as a whole.
 *  - "Still here?": the server asks when no person has been active for 15 minutes (feltkit/_presence.ts enforceIdle) and ends
 *    the call 2 minutes later. This only shows its prompt; any click on it answers. The browser decides nothing.
 *  - "End meeting": the host, or an administrator while the host is not in the call, ends the call and closes the meeting.
 *  - A closed meeting shows that it ended, with the recap, and the host can reopen it. The server refuses joins either way.
 */
export function MeetingFrame({ code, me, isAdmin, onError, children }: { code: string; me: { id: string; name: string }; isAdmin: boolean; onError: (e: unknown) => void; children: ReactNode }) {
  const state = useQueryState(api.meetings.get, { code });
  const stillHere = useMutation(api.calls.stillHere);
  const endMeeting = useMutation(api.meetings.endMeeting);
  const reopen = useMutation(api.meetings.reopen);
  const [, tick] = useState(0);
  const [offset, setOffset] = useState(0); // the server's clock minus this browser's, so the countdown is the server's
  const wasIn = useRef(false);
  const busy = useRef(false);
  const data = state.data;
  const call = data?.call ?? null;
  const ends = call && (call.idleEndsAt ?? 0) > 0 ? call.idleEndsAt! : undefined;

  useEffect(() => {
    if (data) setOffset(data.now - Date.now());
  }, [data?.now]);
  useEffect(() => {
    if (!ends) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [ends]);

  const meeting = data?.meeting;
  const mine = (data?.peers ?? []).filter((p) => p.principalId === me.id && p.kind === "person");
  if (mine.length) wasIn.current = true;
  const closed = Boolean(meeting?.closed);
  const isHost = meeting?.hostId === me.id;
  const hostHere = (data?.peers ?? []).some((p) => p.principalId === meeting?.hostId && p.kind === "person");
  const canEnd = Boolean(call) && !closed && (isHost || (isAdmin && !hostHere));

  const answer = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (const p of mine) {
        try {
          await retrying(() => stillHere({ peerId: p.id }));
          break;
        } catch (error) {
          if ((error as { code?: string })?.code !== "FAILED_PRECONDITION") onError(error); // the call has ended: the room says so
        }
      }
    } finally {
      busy.current = false;
    }
  };
  const end = async () => {
    if (!confirm("End the meeting for everyone? The call stops and the link stays closed until the host reopens it. The recap is kept.")) return;
    try {
      await retrying(() => endMeeting({ code }));
    } catch (error) {
      onError(error);
    }
  };

  // Not mounted for a closed meeting nobody was in (the lobby would open the camera); one that closed around us stays mounted, hidden,
  // so the room closes its own devices as it does when a call ends.
  const showChildren = !closed || wasIn.current;
  const seconds = ends ? Math.max(0, Math.ceil((ends - (Date.now() + offset)) / 1000)) : 0;

  return (
    <>
      {showChildren && <div style={{ display: closed ? "none" : "contents" }}>{children}</div>}
      {closed && meeting && (
        <div className="center">
          <div className="card narrow stack">
            <h1>This meeting has ended</h1>
            <p className="muted">
              {meeting.title} · <code>{meeting.code}</code>
              {meeting.closedByName ? ` · ended by ${meeting.closedByName}` : ""}
              {meeting.closedAt ? ` · ${when(meeting.closedAt)}` : ""}
            </p>
            <p className="muted">The link no longer starts a call. The recap and everything the meeting kept are still here.</p>
            <div className="row-actions">
              <button className="primary" onClick={() => navigate({ page: "recap", code })}>See the recap</button>
              {isHost && <button className="secondary" onClick={() => void retrying(() => reopen({ code })).catch(onError)}>Reopen meeting</button>}
              <button className="secondary" onClick={() => navigate({ page: "home" })}>Home</button>
            </div>
          </div>
        </div>
      )}
      {canEnd && (
        <button className="secondary small" style={{ position: "fixed", top: 8, right: 8, zIndex: 40 }} onClick={() => void end()} title="End the call and close the meeting">
          End meeting
        </button>
      )}
      {ends && mine.length > 0 && !closed && (
        <div className="modal-backdrop" role="alertdialog" aria-live="assertive" aria-label="Still here?" onClick={() => void answer()}>
          <div className="card narrow stack">
            <h1>Still here?</h1>
            <p>Nobody has been active for a while. The call ends in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}.</p>
            <button className="primary" autoFocus onClick={() => void answer()}>I'm still here</button>
          </div>
        </div>
      )}
    </>
  );
}
