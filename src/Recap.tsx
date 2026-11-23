import { useState } from "react";
import { useFeltKit, useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { clock, describe, duration, navigate, when } from "./util";

export function Recap({ code, callNumber, me }: { code: string; callNumber?: number; me: string }) {
  const recap = useQueryState(api.meetings.recap, { code, ...(callNumber ? { callNumber } : {}) });
  const summary = useQueryState(api.summaries.get, { code, ...(callNumber ? { callNumber } : {}) });
  const decided = useQueryState(api.decisions.list, { code });
  const items = useQueryState(api.actions.list, { code });
  const update = useMutation(api.actions.update);
  const remove = useMutation(api.meetings.remove);
  const client = useFeltKit();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const attempt = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setProblem("");
    try {
      await run();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };
  const exportAll = () =>
    attempt(async () => {
      const bundle = await client.query(api.meetings.exportAll, { code });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      a.download = `${code}.json`;
      a.click();
    });
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
          <button className="secondary" disabled={busy} onClick={() => void exportAll()}>Export</button>
          {!live && recap.data?.meeting.hostId === me && <button className="secondary" disabled={busy} onClick={() => confirm("Delete this meeting and everything it kept? This cannot be undone.") && void attempt(async () => (await remove({ code }), navigate({ page: "home" })))}>Delete</button>}
          <button className="primary" onClick={() => navigate({ page: "call", code })}>{live ? "Join" : "Start a new call"}</button>
        </div>
      </div>

      {problem && <p className="error-text" role="alert">{problem}</p>}
      <section className="card">
        <div className="row-actions" style={{ justifyContent: "space-between" }}>
          <h2>Summary</h2>
          <button className="secondary small" disabled={busy || live} title={live ? "Available when the call has ended" : "Ask the model to write a recap with decisions and action items"} onClick={() => void attempt(() => client.action(api.ai.recap, { code, ...(callNumber ? { callNumber } : {}) }))}>{busy ? "Writing…" : "Write an AI recap"}</button>
        </div>
        {summary.data?.summary ? (
          <>
            <p className="summary-text">{summary.data.summary.text}</p>
            <p className="muted small-text">{summary.data.summary.source === "model" ? `Written by ${summary.data.summary.model}, asked for by ${summary.data.summary.authorName}` : summary.data.summary.source === "scribe" ? "Outline by the scribe" : `By ${summary.data.summary.authorName}`}{summary.data.versions > 1 ? ` · version ${summary.data.versions}` : ""}</p>
          </>
        ) : <p className="muted small-text">{live ? "The scribe writes the recap when the call ends." : "No summary yet."}</p>}
      </section>

      <div className="recap-grid">
        <section className="card">
          <h2>Decisions</h2>
          {(decided.data ?? []).length === 0 ? <p className="muted small-text">None recorded.</p> : <ul className="plain">{(decided.data ?? []).map((d) => <li key={d.id}>{d.text} <span className="muted small-text">· {d.madeByName}</span></li>)}</ul>}
        </section>
        <section className="card">
          <h2>Action items</h2>
          {(items.data ?? []).length === 0 ? <p className="muted small-text">None recorded.</p> : (items.data ?? []).map((i) => (
            <label key={i.id} className={`note action ${i.status}`}>
              <input type="checkbox" checked={i.status === "done"} disabled={i.createdById !== me && i.assigneeId !== me && recap.data?.meeting.hostId !== me} onChange={(e) => void update({ id: i.id, status: e.target.checked ? "done" : "open" }).catch((error) => setProblem(describe(error)))} />
              <span><span className="message-text">{i.text}</span><span className="muted small-text"> {i.assigneeName ? `· ${i.assigneeName}` : "· unassigned"}{i.dueAt ? ` · due ${when(i.dueAt)}` : ""}{i.source !== "person" ? ` · ${i.source}` : ""}</span></span>
            </label>
          ))}
        </section>
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
