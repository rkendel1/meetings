/**
 * Records the call in the host's browser: every participant's audio mixed, and the video tiles as they are drawn
 * on screen, saved as a file on the host's device. Nothing is uploaded: the server only keeps that a recording is
 * on (feltkit/recording.ts), which everyone sees. The recording lives in memory until it is saved, so very long
 * calls need an SFU-side recorder (docs/STARTER.md).
 */
export type Recorder = { stop(): Promise<Blob | null> };

const W = 1280;
const H = 720;

export function startRecorder(local: MediaStream, remoteStreams: () => MediaStream[], tiles: () => HTMLVideoElement[]): Recorder | null {
  if (typeof MediaRecorder === "undefined") return null;
  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  const wired = new Set<string>();
  const wire = (s: MediaStream) => {
    if (wired.has(s.id) || !s.getAudioTracks().length) return;
    wired.add(s.id);
    audio.createMediaStreamSource(s).connect(mix);
  };
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  const draw = () => {
    [local, ...remoteStreams()].forEach(wire); // people who joined since the last frame
    g.fillStyle = "#111";
    g.fillRect(0, 0, W, H);
    const live = tiles().filter((v) => v.readyState >= 2 && v.videoWidth > 0);
    if (!live.length) {
      g.fillStyle = "#888";
      g.font = "28px sans-serif";
      g.textAlign = "center";
      g.fillText("Audio only", W / 2, H / 2);
      return;
    }
    const cols = Math.ceil(Math.sqrt(live.length));
    const rows = Math.ceil(live.length / cols);
    const cw = W / cols;
    const ch = H / rows;
    live.forEach((v, i) => {
      const scale = Math.min(cw / v.videoWidth, ch / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      g.drawImage(v, (i % cols) * cw + (cw - w) / 2, Math.floor(i / cols) * ch + (ch - h) / 2, w, h);
    });
  };
  draw();
  const timer = setInterval(draw, 1000 / 15);
  const out = new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...mix.stream.getAudioTracks()]);
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(out, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(4000);
  return {
    stop: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        recorder.onstop = () => {
          void audio.close();
          resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType || "video/webm" }) : null);
        };
        if (recorder.state === "inactive") recorder.onstop?.(new Event("stop"));
        else recorder.stop();
      }),
  };
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
