/**
 * Observations: capture what is on a shared screen and send it into the meeting, as evidence.
 *
 * Explicit and visible: the browser's own picker chooses the screen, window or tab (nothing is captured without it),
 * one frame is taken and the stream is stopped at once, the person selects the region to send, and everyone in the
 * call sees the observation in the timeline. xeet (public/xeet, WebAssembly) builds the screenshot artifact here, where
 * the pixels are: the image's digest and size, and the capture context (method, region, surface). The server verifies
 * the artifact against the uploaded bytes before recording it.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useFeltKit, useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";

type Xeet = { capture_screenshot(image: Uint8Array, request: string): string };
let xeet: Promise<Xeet> | null = null;
function loadXeet(): Promise<Xeet> {
  xeet ??= (async () => {
    const glue = await import(/* @vite-ignore */ `${location.origin}/xeet/xeet_wasm.js`);
    await glue.default({ module_or_path: `${location.origin}/xeet/xeet_wasm_bg.wasm` });
    return glue as Xeet;
  })();
  return xeet;
}

type Frame = { canvas: HTMLCanvasElement; label: string; surface: string; width: number; height: number };

/** One frame of what the person picks in the browser's own picker; the stream stops as soon as it is taken. */
async function grabFrame(): Promise<Frame> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const track = stream.getVideoTracks()[0]!;
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 150));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
    return { canvas, label: track.label, surface: settings.displaySurface ?? "unknown", width: canvas.width, height: canvas.height };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

type Region = { x: number; y: number; w: number; h: number };

export function CaptureDialog({ code, onClose, onError }: { code: string; onClose: () => void; onError: (e: unknown) => void }) {
  const client = useFeltKit();
  const prepare = useMutation(api.observations.prepare);
  const [source, setSource] = useState<"screen" | "import" | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [imported, setImported] = useState<{ artifact: string; contextText?: string; png: Uint8Array; title: string; src: string } | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const shown = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (source !== "screen") return;
    void grabFrame().then(
      (f) => (setFrame(f), setRegion({ x: 0, y: 0, w: f.width, h: f.height })),
      (e) => (onError(e), onClose()),
    );
  }, [source]);

  /**
   * A capture made with xeet's macOS app (with Apple Vision OCR and the accessibility tree): the person picks its
   * package folder (artifact.json and assets/), and the exact bytes it hashed are sent; the server verifies them.
   */
  const pickPackage = async (files: FileList | null) => {
    try {
      const list = [...(files ?? [])];
      const doc = list.find((f) => f.name === "artifact.json");
      const png = list.find((f) => /\.(png|jpe?g)$/i.test(f.name));
      const ctx = list.find((f) => f.name !== "artifact.json" && f.name.endsWith(".json"));
      if (!doc || !png) throw new Error("Choose a xeet capture's folder: it holds artifact.json and assets/ with the image.");
      const artifact = await doc.text();
      const parsed = JSON.parse(artifact);
      if (parsed?.subject?.type !== "screenshot") throw new Error("That artifact is not a screenshot.");
      const bytes = new Uint8Array(await png.arrayBuffer());
      setImported({ artifact, ...(ctx ? { contextText: await ctx.text() } : {}), png: bytes, title: String(parsed.subject.title ?? "xeet capture"), src: URL.createObjectURL(png) });
    } catch (e) {
      onError(e);
    }
  };

  const sendImported = async () => {
    if (!imported) return;
    try {
      setBusy("Uploading…");
      const link = await prepare({ code });
      const put = await fetch(link.url, { method: "PUT", headers: { "content-type": "image/png", "x-file-name": "observation.png" }, body: new Blob([imported.png as BlobPart], { type: "image/png" }) });
      const uploaded = await put.json();
      if (!put.ok || !uploaded.ok) throw new Error(uploaded?.error?.message ?? `Upload failed (${put.status}).`);
      setBusy("Verifying and sending…");
      await client.action(api.observations.add, { code, fileId: uploaded.file.id, artifact: imported.artifact, ...(imported.contextText ? { contextText: imported.contextText } : {}), ...(caption.trim() ? { caption: caption.trim() } : {}) });
      onClose();
    } catch (e) {
      onError(e);
      setBusy(null);
    }
  };

  const toImage = (e: ReactPointerEvent) => {
    const img = shown.current!;
    const box = img.getBoundingClientRect();
    const sx = frame!.width / box.width;
    return { x: Math.max(0, Math.min(frame!.width, (e.clientX - box.left) * sx)), y: Math.max(0, Math.min(frame!.height, (e.clientY - box.top) * sx)) };
  };
  const down = (e: ReactPointerEvent) => {
    drag.current = toImage(e);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const p = toImage(e);
    const a = drag.current;
    setRegion({ x: Math.round(Math.min(a.x, p.x)), y: Math.round(Math.min(a.y, p.y)), w: Math.round(Math.abs(p.x - a.x)), h: Math.round(Math.abs(p.y - a.y)) });
  };
  const up = () => {
    drag.current = null;
    if (region && (region.w < 8 || region.h < 8) && frame) setRegion({ x: 0, y: 0, w: frame.width, h: frame.height });
  };

  const send = async () => {
    if (!frame || !region) return;
    try {
      setBusy("Preparing the image…");
      const crop = document.createElement("canvas");
      crop.width = region.w;
      crop.height = region.h;
      crop.getContext("2d")!.drawImage(frame.canvas, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
      const blob: Blob = await new Promise((done, fail) => crop.toBlob((b) => (b ? done(b) : fail(new Error("Could not encode the image."))), "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      setBusy("Describing the capture (xeet)…");
      const whole = region.x === 0 && region.y === 0 && region.w === frame.width && region.h === frame.height;
      const context = {
        capturedBy: { name: "Meetings (xeet)", version: "0.1" },
        method: "getDisplayMedia",
        mode: whole ? (frame.surface === "monitor" ? "display" : "window") : "region",
        platform: navigator.userAgent.slice(0, 200),
        display: { id: 0, name: frame.label.slice(0, 300), frame: [0, 0, frame.width, frame.height], scale: 1 },
        frame: [region.x, region.y, region.w, region.h],
        permissions: { screenRecording: "granted" },
        notes: [`displaySurface: ${frame.surface}`, "Coordinates are pixels of the captured surface (the browser reports no global screen position)."],
      };
      const built = JSON.parse((await loadXeet()).capture_screenshot(bytes, JSON.stringify({ capturedAt: new Date().toISOString(), method: "getDisplayMedia", declaredType: "image/png", context })));
      setBusy("Uploading…");
      const link = await prepare({ code });
      const put = await fetch(link.url, { method: "PUT", headers: { "content-type": "image/png", "x-file-name": "observation.png" }, body: bytes });
      const uploaded = await put.json();
      if (!put.ok || !uploaded.ok) throw new Error(uploaded?.error?.message ?? `Upload failed (${put.status}).`);
      setBusy("Verifying and sending…");
      await client.action(api.observations.add, { code, fileId: uploaded.file.id, artifact: built.documentText, contextText: built.contextText, ...(caption.trim() ? { caption: caption.trim() } : {}) });
      onClose();
    } catch (e) {
      onError(e);
      setBusy(null);
    }
  };

  const scale = frame && shown.current ? shown.current.getBoundingClientRect().width / frame.width : 0;
  return (
    <div className="modal-backdrop" role="dialog" aria-label="Send an observation">
      <div className="modal capture">
        <h3>Send what you see into the meeting</h3>
        {source === null ? (
          <div className="stack">
            <button className="primary" onClick={() => setSource("screen")}>Capture a screen, window or tab</button>
            <label className="secondary button-like">
              Send a capture from xeet (macOS app)…
              <input type="file" hidden multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => (setSource("import"), void pickPackage(e.target.files))} />
            </label>
            <p className="small-text muted">xeet's macOS app adds what it read (Apple Vision text, the accessibility tree), so models that cannot see get it too, marked as inference. Choose the capture's folder (Show Capture Files → its artifact folder).</p>
          </div>
        ) : source === "import" ? (
          imported ? (
            <>
              <img className="capture-preview" src={imported.src} alt={imported.title} />
              <p className="small-text muted">{imported.title}</p>
              <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={500} placeholder="What does it show? (optional)" aria-label="Caption" />
            </>
          ) : (
            <p className="muted">Reading the capture…</p>
          )
        ) : !frame ? (
          <p className="muted">Choose a screen, window or tab in your browser's picker. One frame is taken; nothing is recorded.</p>
        ) : (
          <>
            <p className="small-text muted">Drag to select the region to send. Everyone in the call will see it, attributed to you.</p>
            <div className="capture-frame" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
              <img ref={shown} src={frame.canvas.toDataURL("image/png")} alt="The captured frame" draggable={false} />
              {region && scale > 0 && <div className="capture-region" style={{ left: region.x * scale, top: region.y * scale, width: region.w * scale, height: region.h * scale }} />}
            </div>
            <p className="small-text muted">{frame.label || frame.surface} · region {region ? `${region.w}×${region.h} at ${region.x},${region.y}` : "—"}</p>
            <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={500} placeholder="What does it show? (optional)" aria-label="Caption" />
          </>
        )}
        <div className="row">
          {source !== null && <button className="primary" disabled={(source === "screen" ? !frame || !region : !imported) || Boolean(busy)} onClick={() => void (source === "screen" ? send() : sendImported())}>{busy ?? "Send to meeting"}</button>}
          <button className="secondary" disabled={Boolean(busy)} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** An observation in the timeline: who captured what, and the original image on request. */
export function ObservationLine({ code, entryId, text, onError }: { code: string; entryId: string; text: string; onError: (e: unknown) => void }) {
  const list = useQueryState(api.observations.list, { code });
  const client = useFeltKit();
  const [image, setImage] = useState<{ src: string; detail: any } | null>(null);
  const o = (list.data ?? []).find((x: any) => x.entryId === entryId);
  const open = async () => {
    if (!o) return;
    try {
      const got: any = await client.query(api.observations.get, { id: o.id });
      setImage({ src: `data:${got.mediaType};base64,${got.imageBase64}`, detail: got });
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="observation">
      <div className="message-text">📷 {text}</div>
      {o && !image && <button className="secondary small" onClick={() => void open()}>View the observation</button>}
      {image && (
        <figure>
          <img src={image.src} alt={o?.caption ?? "Observation"} />
          <figcaption className="small-text muted">
            {image.detail.capturedByName} · {new Date(image.detail.capturedAt).toLocaleTimeString()} · {image.detail.method}/{image.detail.mode}
            {image.detail.region ? ` · ${image.detail.region.w}×${image.detail.region.h} at ${image.detail.region.x},${image.detail.region.y}` : ""}
            {image.detail.surface?.label ? ` · ${image.detail.surface.label}` : ""} · <code title={image.detail.sha256}>{image.detail.sha256.slice(0, 19)}…</code>
          </figcaption>
        </figure>
      )}
    </div>
  );
}
