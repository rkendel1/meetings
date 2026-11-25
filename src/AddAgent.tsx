/**
 * "Add Eve": the organization's agents, offered to the meeting's host. Adding one authorizes it to take part in this
 * meeting and starts its execution under the organization's own delegation, in the agent's application. It never
 * grants the agent authority to act for anyone: repository changes and other consequential actions keep their own
 * grants and need a person's approval of the exact call.
 */
import { useState } from "react";
import { useFeltKit, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

const STATUS: Record<string, string> = { invited: "Invited", started: "Running · joining the meeting", failed: "Could not start", removed: "Removed" };

export function OrgAgents({ code, isHost, onError }: { code: string; isHost: boolean; onError: (e: unknown) => void }) {
  const agents = useQueryState(api.orgagents.forMeeting, { code });
  const client = useFeltKit();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (fn: typeof api.orgagents.add | typeof api.orgagents.remove, principalId: string) => {
    setBusy(principalId);
    try {
      const result: any = await client.action(fn as never, { code, principalId } as never);
      if (result.status === "failed") onError(new Error(`It is invited, but its execution did not start: ${result.detail}`));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };
  const list = (agents.data ?? []).filter((a: any) => a.status === "active");
  if (!list.length) return <p className="small-text muted">This organization has no active agents. An administrator registers them.</p>;
  return (
    <div className="stack">
      {list.map((a: any) => {
        const here = a.participation && a.participation.status !== "removed";
        return (
          <div key={a.principalId} className="agent-card">
            <div className="agent-card-head">
              <b>{a.name}</b>
              <span className="badge agent-badge">Organization-owned agent · Enabled</span>
            </div>
            {a.purpose && <p className="small-text">{a.purpose}</p>}
            {a.operatedBy && <p className="small-text muted">Operated by {a.operatedBy}</p>}
            <p className="small-text muted">In this meeting, {a.name} may:</p>
            <ul className="small-text">
              <li>read authorized meeting context, chat, captions and observations</li>
              <li>take part in the conversation</li>
              <li>track decisions and action items (an agent's decision is a proposal until a person confirms it)</li>
              {a.connector && <li>work under the organization's preconfigured delegation</li>}
            </ul>
            <p className="small-text muted">Repository changes and other consequential actions keep their own grants and need a person's approval of the exact call.</p>
            {a.participation && (
              <p className="small-text">
                {STATUS[a.participation.status] ?? a.participation.status} · added by {a.participation.addedByName}
                {a.participation.detail ? ` · ${a.participation.detail}` : ""}
              </p>
            )}
            {isHost ? (
              here ? (
                <button className="secondary small" disabled={busy === a.principalId} onClick={() => void act(api.orgagents.remove, a.principalId)}>Remove {a.name} from this meeting</button>
              ) : (
                <button className="primary small" disabled={busy === a.principalId} onClick={() => void act(api.orgagents.add, a.principalId)}>{busy === a.principalId ? "Adding…" : `Add ${a.name}`}</button>
              )
            ) : (
              !here && <p className="small-text muted">The host can add {a.name}.</p>
            )}
            <p className="small-text muted">Authorized by organization policy.</p>
          </div>
        );
      })}
    </div>
  );
}
