import { useEffect, useRef, useState } from "react";
import { useConnectionState, useFeltKit, useSession } from "@feltdb/feltkit/react";
import { ThemeToggle } from "./theme";
import { ResetForm, SignedOut } from "./auth";
import { Home } from "./Home";
import { Call } from "./Call";
import { Recap } from "./Recap";
import { describe, navigate, useRoute } from "./util";

type Notice = { tone: "error" | "info"; text: string } | null;

export function App() {
  const { session, signInAsDevUser, signIn, signUp, signOut } = useSession();
  const live = useConnectionState();
  const route = useRoute();
  const [notice, setNotice] = useState<Notice>(null);
  const principal = session?.principal ?? null;

  // In development, sign in as the first dev user so the app works on first load.
  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const report = (error: unknown) => setNotice({ tone: "error", text: describe(error) });

  const client = useFeltKit();
  const [resetToken, setResetToken] = useState<string | null>(null);
  useEffect(() => {
    void client.handleRedirect().then((r) => {
      if (r?.kind === "reset") setResetToken(r.token);
      else if (r?.kind === "verified") setNotice({ tone: "info", text: `${r.email} is verified.` });
      else if (r?.kind === "error" || r?.kind === "verify-failed") setNotice({ tone: "error", text: r.message });
    });
  }, [client]);

  const inCall = route.page === "call" && principal;

  return (
    <div className={`shell ${inCall ? "in-call" : ""}`}>
      {!inCall && (
        <header className="topbar">
          <a className="brand" href="/" onClick={(e) => (e.preventDefault(), navigate({ page: "home" }))}>
            <span className="logo" aria-hidden>
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v1.8l3.2-2.1A1.2 1.2 0 0 1 21 7.2v9.6a1.2 1.2 0 0 1-1.8 1L16 15.7v1.8a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 17.5z" /></svg>
            </span>
            <span className="brand-name">Meetings</span>
            {session && !session.environment.production && <span className="env">{session.environment.name}</span>}
          </a>
          <div className="topbar-right">
            <span className={`live ${live ? "on" : ""}`} title={live ? "Live: changes from anyone appear here immediately" : "Connecting…"}>
              <span className="dot" /> {live ? "Live" : "Connecting"}
            </span>
            {session && session.devUsers.length > 0 && (
              <label className="identity">
                <span className="sr-only">Signed in as</span>
                <select value={principal?.id ?? ""} onChange={(e) => (e.target.value ? signInAsDevUser(e.target.value).catch(report) : signOut())} aria-label="Signed in as">
                  <option value="">Signed out</option>
                  {session.devUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </label>
            )}
            {principal && !session?.devUsers.length && (
              <button className="secondary small" onClick={() => void signOut().catch(report)} title={principal.displayName ?? principal.id}>Sign out</button>
            )}
            <ThemeToggle />
            {session?.dashboard && <a className="dashboard-link" href={session.dashboard} target="_blank" rel="noreferrer">Studio ↗</a>}
          </div>
        </header>
      )}

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {!session ? (
        <div className="center muted">Connecting…</div>
      ) : resetToken ? (
        <div className="center"><div className="card narrow"><ResetForm token={resetToken} onDone={() => (setResetToken(null), setNotice({ tone: "info", text: "Your password is set." }))} /></div></div>
      ) : !principal ? (
        <SignedOut devUsers={session.devUsers} accounts={session.accounts ?? null} onDevSignIn={(id) => signInAsDevUser(id).catch(report)} onSignIn={signIn} onSignUp={signUp} />
      ) : route.page === "call" ? (
        <Call key={`${route.code}:${principal.id}`} code={route.code} me={{ id: principal.id, name: principal.displayName ?? principal.id }} onError={report} />
      ) : route.page === "recap" ? (
        <Recap code={route.code} callNumber={route.call} />
      ) : (
        <Home me={{ id: principal.id, name: principal.displayName ?? principal.id }} onError={report} />
      )}
    </div>
  );
}
