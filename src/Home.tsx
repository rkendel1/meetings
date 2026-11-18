import { useState, type FormEvent } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { codeFrom, describe, navigate, when } from "./util";

export function Home({ me, onError }: { me: { id: string; name: string }; onError: (e: unknown) => void }) {
  const meetings = useQueryState(api.meetings.list);
  const create = useMutation(api.meetings.create);
  const [title, setTitle] = useState("");
  const [access, setAccess] = useState<"link" | "invited">("link");
  const [invited, setInvited] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [join, setJoin] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async (now: boolean, e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const m = await create({
        title: title.trim() || (now ? `${me.name.split(" ")[0]}'s meeting` : "Meeting"),
        access,
        invited: invited.split(/[\s,]+/).filter(Boolean),
        ...(!now && scheduled ? { scheduledFor: new Date(scheduled).getTime() } : {}),
      });
      setTitle(""); setInvited(""); setScheduled("");
      if (now) navigate({ page: "call", code: m.code });
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const joinCode = codeFrom(join);
  const list = meetings.data ?? [];

  return (
    <main className="home">
      <section className="hero">
        <h1>Meet with your team, and with your agents.</h1>
        <p className="muted">Video, screen share, chat and live captions in the browser. Agents attend through MCP: they follow what is said, chat, and leave notes in the recap.</p>
        <div className="hero-actions">
          <button className="primary big" disabled={busy} onClick={() => void start(true)}>Start a meeting now</button>
          <form className="join-form" onSubmit={(e) => (e.preventDefault(), joinCode && navigate({ page: "call", code: joinCode }))}>
            <input value={join} onChange={(e) => setJoin(e.target.value)} placeholder="Enter a code or link" aria-label="Meeting code or link" />
            <button className="secondary" disabled={!joinCode}>Join</button>
          </form>
        </div>
      </section>

      <div className="home-grid">
        <section className="card">
          <h2>New meeting</h2>
          <form className="stack" onSubmit={(e) => void start(false, e)}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" maxLength={120} />
            <label className="field">
              <span>Who can join</span>
              <select value={access} onChange={(e) => setAccess(e.target.value as "link" | "invited")}>
                <option value="link">Anyone signed in with the link (people and agents)</option>
                <option value="invited">Only people and agents I invite</option>
              </select>
            </label>
            <label className="field">
              <span>Invite (user or agent ids, comma separated)</span>
              <input value={invited} onChange={(e) => setInvited(e.target.value)} placeholder="grace, claude" />
            </label>
            <label className="field">
              <span>When (optional)</span>
              <input type="datetime-local" value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
            </label>
            <button className="primary" disabled={busy}>Create</button>
          </form>
        </section>

        <section className="card">
          <h2>Your meetings</h2>
          {meetings.error && !meetings.data ? (
            <p className="error-text">{describe(meetings.error)}</p>
          ) : meetings.isLoading && !meetings.data ? (
            <p className="muted">Loading…</p>
          ) : list.length === 0 ? (
            <p className="muted">No meetings yet. Start one, or create one for later.</p>
          ) : (
            <ul className="meeting-list">
              {list.map((m) => (
                <li key={m.id} className="meeting-row">
                  <div className="meeting-main">
                    <div className="meeting-title">
                      {m.live && <span className="badge live-badge">Live · {m.attendees}</span>}
                      {m.title}
                    </div>
                    <div className="muted small-text">
                      <code>{m.code}</code> · {m.hostId === me.id ? "you host" : `hosted by ${m.hostName}`} · {m.access === "link" ? "anyone with the link" : `${m.invited.length} invited`}
                      {m.scheduledFor ? ` · ${when(m.scheduledFor)}` : ""}
                    </div>
                  </div>
                  <div className="row-actions">
                    {m.lastCallAt && <button className="secondary small" onClick={() => navigate({ page: "recap", code: m.code })}>Recap</button>}
                    <button className="primary small" onClick={() => navigate({ page: "call", code: m.code })}>{m.live ? "Join" : "Open"}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
