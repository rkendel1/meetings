/**
 * Administrators register and suspend the organization's agents here (Agents panel). Only `orgagents.register` and
 * `orgagents.setStatus` change anything, and the server lets only holders of `agents.manage` (the admin role) call them:
 * this component is shown to them and to no one else, but it is not what keeps anyone out.
 *
 * The connect grant is a secret. It is typed into a masked field, sent once, and cleared whether or not the call
 * worked. It is never displayed again, never put in a message or log line, and no query returns it.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { emptyRegistration, registrationArgs, registrationProblem, type RegistrationForm } from "./agent-admin";

export function AgentRegistry({ onError }: { onError: (e: unknown) => void }) {
  const agents = useQueryState(api.orgagents.list);
  const register = useMutation(api.orgagents.register);
  const setStatus = useMutation(api.orgagents.setStatus);
  const [form, setForm] = useState<RegistrationForm>(emptyRegistration);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const rows = agents.data ?? [];
  const set = (patch: Partial<RegistrationForm>) => setForm((f) => ({ ...f, ...patch }));
  const exists = rows.some((a: any) => a.principalId === form.principalId.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setNote("");
    const problem = registrationProblem(form, exists);
    if (problem) return onError(new Error(problem));
    const args = registrationArgs(form);
    setBusy("register");
    // The grant leaves the form now, success or not; a failed call asks for it again rather than keeping it on screen.
    setForm((f) => ({ ...f, connectorGrant: "" }));
    try {
      const saved: any = await register(args as never);
      setNote(`${saved.name} is registered and active.`);
      setForm(emptyRegistration);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  const change = async (principalId: string, name: string, status: "active" | "disabled") => {
    if (status === "disabled" && !window.confirm(`Suspend ${name}? It leaves every call it is in, right away, and cannot attend until you reactivate it.`)) return;
    setBusy(principalId);
    setNote("");
    try {
      await setStatus({ principalId, status } as never);
      setNote(status === "disabled" ? `${name} is suspended.` : `${name} is active again.`);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="stack" aria-label="Register an organization agent">
      <h3>Register an organization agent</h3>
      <p className="small-text muted">
        Administrators only. A registered agent can attend meetings it is invited to, as a participant without media. Registering gives it no other authority: repository changes and other consequential actions keep their own grants and need a person's approval. Registering an id that already exists updates it and makes it active.
      </p>
      <form className="stack" onSubmit={submit} autoComplete="off">
        <label className="field"><span>Principal id (the identity the agent signs in as, e.g. eve)</span>
          <input value={form.principalId} onChange={(e) => set({ principalId: e.target.value })} maxLength={120} required spellCheck={false} /></label>
        <label className="field"><span>Name</span>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} required /></label>
        <label className="field"><span>Purpose</span>
          <input value={form.purpose} onChange={(e) => set({ purpose: e.target.value })} maxLength={300} /></label>
        <label className="field"><span>Operated by</span>
          <input value={form.operatedBy} onChange={(e) => set({ operatedBy: e.target.value })} maxLength={200} /></label>
        <label className="field"><span>Connector (how it is started in a meeting)</span>
          <select value={form.connector} onChange={(e) => set({ connector: e.target.value as RegistrationForm["connector"] })}>
            <option value="eve">Eve app</option>
            <option value="">None: the organization starts it elsewhere</option>
          </select></label>
        {form.connector === "eve" && (
          <label className="field"><span>Connect grant issued by the Eve app{exists ? " (leave empty to keep the one already recorded)" : ""}</span>
            <input type="password" name="connect-grant" value={form.connectorGrant} onChange={(e) => set({ connectorGrant: e.target.value })} maxLength={120} autoComplete="new-password" spellCheck={false} />
            <span className="small-text muted">A secret. It is stored by the server for starting Eve in meetings, and is never shown again.</span></label>
        )}
        <button className="primary small" disabled={busy === "register"}>{busy === "register" ? "Registering…" : exists ? "Update agent" : "Register agent"}</button>
      </form>
      {note && <p className="small-text muted" role="status">{note}</p>}

      <h3>Registered agents</h3>
      {!rows.length && <p className="small-text muted">No agents are registered yet.</p>}
      {rows.map((a: any) => (
        <div key={a.principalId} className="agent-card">
          <div className="agent-card-head">
            <b>{a.name}</b>
            <code>{a.principalId}</code>
            <span className="badge agent-badge">{a.status === "active" ? "Active" : "Suspended"}</span>
            {a.connector && <span className="badge">Connector: {a.connector}</span>}
          </div>
          {a.purpose && <p className="small-text">{a.purpose}</p>}
          {a.operatedBy && <p className="small-text muted">Operated by {a.operatedBy}</p>}
          <p className="small-text muted">Registered by {a.registeredByName}</p>
          <div className="row-actions">
            <button type="button" className="secondary small" onClick={() => setForm({ principalId: a.principalId, name: a.name, purpose: a.purpose ?? "", operatedBy: a.operatedBy ?? "", connector: a.connector ?? "", connectorGrant: "" })}>Edit</button>
            {a.status === "active"
              ? <button type="button" className="secondary small" disabled={busy === a.principalId} onClick={() => void change(a.principalId, a.name, "disabled")}>Suspend</button>
              : <button type="button" className="primary small" disabled={busy === a.principalId} onClick={() => void change(a.principalId, a.name, "active")}>Reactivate</button>}
          </div>
        </div>
      ))}
    </section>
  );
}
