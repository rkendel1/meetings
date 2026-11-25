import { useEffect, useRef, useState } from "react";
import { useConnectionState, useFeltKit, useSession } from "@feltdb/feltkit/react";
import { ThemeToggle } from "./theme";
import { ResetForm, SignedOut } from "./auth";
import { Home } from "./Home";
import { Call } from "./Call";
import { MeetingFrame } from "./MeetingFrame";
import { Recap } from "./Recap";
import { Settings } from "./Settings";
import { DEMO, PERSONAS, chosenPersona, signInAsPersona } from "./demo";
import { BrandMark, useApplyBrand, useBrand } from "./brand";
import { describe, navigate, useRoute } from "./util";

type Notice = { tone: "error" | "info"; text: string } | null;

export function App() {
  const { session, signInAsDevUser, signIn, signUp, signOut } = useSession();
  const live = useConnectionState();
  const route = useRoute();
  const [notice, setNotice] = useState<Notice>(null);
  const principal = session?.principal ?? null;
  const brand = useBrand();
  useApplyBrand(brand);
  const isAdmin = Boolean(session?.permissions?.includes("settings.write"));

  // In development, sign in as the first dev user so the app works on first load.
  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);

  // Demo build: no sign-in screen. The first visit signs in as a persona (creating its account the first time).
  const [demoStarting, setDemoStarting] = useState(DEMO);
  const demoTried = useRef(false);
  useEffect(() => {
    if (!DEMO || !session || principal || demoTried.current || session.devUsers.length) return;
    demoTried.current = true;
    void signInAsPersona({ signIn, signUp }, chosenPersona().id)
      .catch((error) => setNotice({ tone: "error", text: `The demo could not sign you in: ${describe(error)}` }))
      .finally(() => setDemoStarting(false));
  }, [session, principal, signIn, signUp]);
  useEffect(() => {
    if (principal) setDemoStarting(false);
  }, [principal]);

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
            <BrandMark brand={brand} />
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
            {DEMO && principal && !session?.devUsers.length && (
              <label className="identity">
                <span className="sr-only">Demo persona</span>
                <select value={PERSONAS.find((p) => p.name === principal.displayName)?.id ?? ""} aria-label="Demo persona" title="Switch persona to meet yourself: open a second browser as someone else" onChange={(e) => void signOut().then(() => signInAsPersona({ signIn, signUp }, e.target.value)).catch(report)}>
                  {PERSONAS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            {!DEMO && principal && !session?.devUsers.length && (
              <button className="secondary small" onClick={() => void signOut().catch(report)} title={principal.displayName ?? principal.id}>Sign out</button>
            )}
            {isAdmin && <a className="dashboard-link" href="/settings" onClick={(e) => (e.preventDefault(), navigate({ page: "settings" }))}>Settings</a>}
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
      ) : !principal && DEMO && demoStarting ? (
        <div className="center muted">Starting the demo…</div>
      ) : !principal ? (
        <SignedOut brand={brand} devUsers={session.devUsers} accounts={session.accounts ?? null} onDevSignIn={(id) => signInAsDevUser(id).catch(report)} onSignIn={signIn} onSignUp={signUp} />
      ) : route.page === "call" ? (
        <MeetingFrame key={`${route.code}:${principal.id}`} code={route.code} me={{ id: principal.id, name: principal.displayName ?? principal.id }} isAdmin={isAdmin} onError={report}>
          <Call code={route.code} me={{ id: principal.id, name: principal.displayName ?? principal.id }} onError={report} />
        </MeetingFrame>
      ) : route.page === "settings" ? (
        isAdmin ? <Settings onError={report} /> : <div className="center muted">Settings are for administrators.</div>
      ) : route.page === "recap" ? (
        <Recap code={route.code} callNumber={route.call} me={principal.id} />
      ) : (
        <Home me={{ id: principal.id, name: principal.displayName ?? principal.id }} onError={report} />
      )}
    </div>
  );
}
