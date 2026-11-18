import { useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { clock, describe, duration, navigate, when } from "./util";

export function Recap({ code, callNumber }: { code: string; callNumber?: number }) {
  const recap = useQueryState(api.meetings.recap, { code, ...(callNumber ? { callNumber } : {}) });
  if (recap.error && !recap.data) {
    return (
      <div className="center"><div className="card narrow stack">
        <h1>No recap</h1>
        <p className="muted">{describe(recap.error)}</p>
        <button className="secondary" onClick={() => navigate({ page: "call", code })}>Open the meeting</button>
      </div></div>
    );
  }
  if (!recap.data) return <div className="center muted">Loading recap…</div>;
  const { meeting, call, live, attendance, entries, calls } = recap.data;
  const notes = entries.filter((e) => e.kind === "note");
  const timeline = entries.filter((e) => e.kind === "chat" || e.kind === "caption" || e.kind === "system");
  const reactions = entries.filter((e) => e.kind === "reaction");
  const counts = new Map<string, number>();
  for (const r of reactions) counts.set(r.text, (counts.get(r.text) ?? 0) + 1);

  return (
    <main className="recap">
      <div className="recap-head">
        <div>
          <p className="muted small-text"><code>{meeting.code}</code> · call {call.number} of {calls.length}</p>
          <h1>{meeting.title}</h1>
          <p className="muted">
            {when(call.startedAt)} · {live ? "in progress" : `${duration((call.endedAt ?? Date.now()) - call.startedAt)}`} · {attendance.filter((a) => a.kind === "person").length} people
            {(() => { const n = attendance.filter((a) => a.kind === "agent").length; return n ? `, ${n} agent${n === 1 ? "" : "s"}` : ""; })()}
          </p>
        </div>
        <div className="row-actions">
          {calls.length > 1 && (
            <select aria-label="Call" value={call.number} onChange={(e) => navigate({ page: "recap", code, call: Number(e.target.value) })}>
              {calls.map((c) => <option key={c.id} value={c.number}>Call {c.number} · {when(c.startedAt)}</option>)}
            </select>
          )}
          <button className="primary" onClick={() => navigate({ page: "call", code })}>{live ? "Join" : "Start a new call"}</button>
        </div>
      </div>

      <div className="recap-grid">
        <section className="card">
          <h2>Attendance</h2>
          <table className="attendance">
            <thead><tr><th>Who</th><th>Joined</th><th>Left</th><th>Time</th></tr></thead>
            <tbody>
              {attendance.map((a) => (
                <tr key={a.principalId}>
                  <td>{a.name} {a.kind === "agent" && <span className="badge agent-badge">AI agent</span>}</td>
                  <td>{clock(a.firstJoinedAt)}</td>
                  <td>{live && a.lastLeftAt >= Date.now() - 60_000 ? "—" : clock(a.lastLeftAt)}</td>
                  <td>{a.minutes} min{a.devices > 1 ? ` · ${a.devices} devices` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {counts.size > 0 && <p className="reaction-summary">{[...counts].map(([r, n]) => <span key={r}>{r} {n}</span>)}</p>}
        </section>

        <section className="card">
          <h2>Notes</h2>
          {notes.length === 0 ? (
            <p className="muted small-text">No notes. An attending agent can add a summary and action items with <code>notes.add</code>.</p>
          ) : (
            notes.map((n) => (
              <div key={n.id} className="note">
                <div className="message-meta"><b>{n.authorName}</b>{n.authorKind === "agent" && <span className="badge agent-badge">AI agent</span>}<span className="muted">{clock(n.createdAt)}</span></div>
                <div className="message-text">{n.text}</div>
              </div>
            ))
          )}
        </section>
      </div>

      <section className="card">
        <h2>Transcript and chat</h2>
        {timeline.length === 0 ? (
          <p className="muted small-text">Nothing was said in chat or captioned.</p>
        ) : (
          <ol className="timeline">
            {timeline.map((e) => (
              <li key={e.id} className={e.kind}>
                <span className="muted">{clock(e.createdAt)}</span>
                {e.kind === "system" ? <span className="muted">{e.text}</span> : (
                  <span><b>{e.authorName}</b>{e.authorKind === "agent" && <span className="badge agent-badge">AI agent</span>} {e.kind === "chat" && <span className="badge">chat</span>} {e.text}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
