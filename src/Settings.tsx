import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { describe, navigate } from "./util";

const MAX_LOGO_BYTES = 120_000;

/** Make this deployment yours: its name, colour and logo, and how long meetings are kept. Admins only. */
export function Settings({ onError }: { onError: (e: unknown) => void }) {
  const current = useQueryState(api.settings.get);
  const save = useMutation(api.settings.save);
  const sweep = useMutation(api.maintenance.sweep);
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [accent, setAccent] = useState("");
  const [logo, setLogo] = useState("");
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const loaded = current.data;
  useEffect(() => {
    if (!loaded) return;
    setName(loaded.name);
    setTagline(loaded.tagline ?? "");
    setAccent(loaded.accent ?? "");
    setLogo(loaded.logo ?? "");
    setDays(loaded.retentionDays ? String(loaded.retentionDays) : "");
  }, [loaded?.name, loaded?.tagline, loaded?.accent, loaded?.logo, loaded?.retentionDays]);

  if (current.error && !current.data) {
    return (
      <div className="center"><div className="card narrow stack">
        <h1>Settings</h1>
        <p className="muted">{describe(current.error)}</p>
        <button className="secondary" onClick={() => navigate({ page: "home" })}>Back</button>
      </div></div>
    );
  }

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) return onError(new Error(`The logo is ${Math.round(file.size / 1000)} kB: use one under ${MAX_LOGO_BYTES / 1000} kB.`));
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await save({ name, ...(tagline.trim() ? { tagline } : {}), ...(accent ? { accent } : {}), ...(logo ? { logo } : {}), ...(days ? { retentionDays: Number(days) } : {}) });
      setNote("Saved. Every open page now shows it.");
    } catch (error) {
      onError(error);
    }
  };
  return (
    <main className="home">
      <div className="home-grid">
        <section className="card">
          <h2>Brand</h2>
          <form className="stack" onSubmit={submit}>
            <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></label>
            <label className="field"><span>Tagline</span><input value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={160} /></label>
            <label className="field"><span>Accent colour</span>
              <span className="row-actions"><input type="color" value={accent || "#166534"} onChange={(e) => setAccent(e.target.value)} aria-label="Accent colour" />
                <code>{accent || "default"}</code>{accent && <button type="button" className="ghost" onClick={() => setAccent("")}>Reset</button>}</span>
            </label>
            <label className="field"><span>Logo (PNG, JPEG, WebP or SVG, under {MAX_LOGO_BYTES / 1000} kB)</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => pick(e.target.files?.[0])} />
            </label>
            {logo && <p className="row-actions"><img src={logo} alt="Logo preview" width={40} height={40} style={{ objectFit: "contain" }} /><button type="button" className="ghost" onClick={() => setLogo("")}>Remove logo</button></p>}
            <label className="field"><span>Delete meetings this many days after their last call (empty: keep forever)</span>
              <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
            <button className="primary">Save</button>
            {note && <p className="muted small-text" role="status">{note}</p>}
          </form>
        </section>
        <section className="card stack">
          <h2>Housekeeping</h2>
          <p className="muted small-text">One scheduled job ends calls nobody is writing to, sends due reminders and applies the retention above. Schedule job type <code>maintenance.sweep</code> every minute in Studio → Services → Schedules, or run it now.</p>
          <button className="secondary" onClick={() => void sweep({}).then((r) => setNote(`Ended ${r.settled} calls, sent ${r.reminded} reminders, deleted ${r.purged} meetings.`)).catch(onError)}>Run the sweep now</button>
        </section>
      </div>
    </main>
  );
}
