import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { Mesh } from "./rtc";
import { clock, describe, navigate, retrying } from "./util";

type Me = { id: string; name: string };
type Peer = { id: string; callId: string; principalId: string; name: string; kind: "person" | "agent"; joinedAt: number; lastSeenAt: number; leftAt?: number; mic: boolean; cam: boolean; screen: boolean; hand: boolean };
type Entry = { id: string; seq: number; kind: "chat" | "caption" | "reaction" | "note" | "system"; authorId: string; authorName: string; authorKind: "person" | "agent"; text: string; createdAt: number };
type Joined = { peerId: string; callId: string; callNumber: number };

const REACTIONS = ["👍", "👏", "😂", "🎉", "❤️", "🤔"] as const;
const HEARTBEAT_MS = 15_000;

export function Call({ code, me, onError }: { code: string; me: Me; onError: (e: unknown) => void }) {
  const state = useQueryState(api.meetings.get, { code });
  const [joined, setJoined] = useState<Joined | null>(null);
  const [left, setLeft] = useState<string | null>(null);
  const [media, setMedia] = useState<{ stream: MediaStream | null; mic: boolean; cam: boolean; error?: string }>({ stream: null, mic: true, cam: true });

  if (state.error && !state.data) {
    return (
      <div className="center"><div className="card narrow stack">
        <h1>Can't open this meeting</h1>
        <p className="muted">{describe(state.error)}</p>
        <button className="secondary" onClick={() => navigate({ page: "home" })}>Back to meetings</button>
      </div></div>
    );
  }
  if (!state.data) return <div className="center muted">Opening {code}…</div>;
  const { meeting } = state.data;

  if (left) {
    return (
      <div className="center"><div className="card narrow stack">
        <h1>{left}</h1>
        <p className="muted">{meeting.title} · <code>{meeting.code}</code></p>
        <div className="row-actions">
          <button className="primary" onClick={() => (setLeft(null), setJoined(null))}>Rejoin</button>
          <button className="secondary" onClick={() => navigate({ page: "recap", code })}>See the recap</button>
          <button className="secondary" onClick={() => navigate({ page: "home" })}>Home</button>
        </div>
      </div></div>
    );
  }

  if (!joined) return <Lobby code={code} me={me} title={meeting.title} peers={state.data.peers as Peer[]} media={media} setMedia={setMedia} onJoined={setJoined} onError={onError} />;
  return <Room code={code} me={me} meeting={meeting} isHost={meeting.hostId === me.id} joined={joined} peers={state.data.peers as Peer[]} callOpen={state.data.call?.id === joined.callId} initial={media} onLeft={setLeft} onError={onError} />;
}

/** Preview and choose devices, then join. */
function Lobby(props: { code: string; me: Me; title: string; peers: Peer[]; media: { stream: MediaStream | null; mic: boolean; cam: boolean; error?: string }; setMedia: (m: { stream: MediaStream | null; mic: boolean; cam: boolean; error?: string }) => void; onJoined: (j: Joined) => void; onError: (e: unknown) => void }) {
  const join = useMutation(api.calls.join);
  const [name, setName] = useState(props.me.name);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioId, setAudioId] = useState<string>("");
  const [videoId, setVideoId] = useState<string>("");
  const video = useRef<HTMLVideoElement>(null);
  const handoff = useRef(false); // the room takes over the stream once joined
  const { media, setMedia } = props;

  useEffect(() => {
    let cancelled = false;
    let acquired: MediaStream | null = null;
    (async () => {
      try {
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: audioId ? { deviceId: { exact: audioId } } : true,
          video: videoId ? { deviceId: { exact: videoId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) return acquired.getTracks().forEach((t) => t.stop());
        acquired.getAudioTracks().forEach((t) => (t.enabled = media.mic));
        acquired.getVideoTracks().forEach((t) => (t.enabled = media.cam));
        setMedia({ ...media, stream: acquired, error: undefined });
        setDevices(await navigator.mediaDevices.enumerateDevices());
      } catch (error) {
        if (!cancelled) setMedia({ stream: null, mic: false, cam: false, error: `No camera or microphone: ${(error as Error).message}. You can still join, chat and watch.` });
      }
    })();
    return () => {
      cancelled = true;
      // Keep the stream the room takes over; stop one replaced by a device change.
      if (acquired && !handoff.current) acquired.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioId, videoId]);

  useEffect(() => {
    if (video.current) video.current.srcObject = media.stream;
  }, [media.stream]);

  const toggle = (kind: "mic" | "cam") => {
    const next = !media[kind];
    media.stream?.[kind === "mic" ? "getAudioTracks" : "getVideoTracks"]().forEach((t) => (t.enabled = next));
    setMedia({ ...media, [kind]: next });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const j = await retrying(() => join({ code: props.code, name: name.trim() || undefined, mic: media.mic && Boolean(media.stream), cam: media.cam && Boolean(media.stream) }));
      handoff.current = true;
      props.onJoined(j);
    } catch (error) {
      props.onError(error);
      setBusy(false);
    }
  };

  const people = props.peers.filter((p) => p.kind === "person");
  const agents = props.peers.filter((p) => p.kind === "agent");
  const ready = Boolean(media.stream || media.error);

  return (
    <div className="lobby">
      <div className="lobby-preview">
        <div className="preview-frame">
          <video ref={video} autoPlay playsInline muted className={media.cam && media.stream ? "" : "hidden"} />
          {!(media.cam && media.stream) && <div className="avatar big">{initials(name)}</div>}
          <div className="preview-controls">
            <button type="button" className={`round ${media.mic ? "" : "off"}`} onClick={() => toggle("mic")} disabled={!media.stream} aria-label={media.mic ? "Turn microphone off" : "Turn microphone on"}>{media.mic ? <MicIcon /> : <MicOffIcon />}</button>
            <button type="button" className={`round ${media.cam ? "" : "off"}`} onClick={() => toggle("cam")} disabled={!media.stream} aria-label={media.cam ? "Turn camera off" : "Turn camera on"}>{media.cam ? <CamIcon /> : <CamOffIcon />}</button>
          </div>
        </div>
        {media.error && <p className="muted small-text">{media.error}</p>}
        {devices.length > 0 && (
          <div className="device-row">
            <select aria-label="Microphone" value={audioId} onChange={(e) => setAudioId(e.target.value)}>
              <option value="">Default microphone</option>
              {devices.filter((d) => d.kind === "audioinput" && d.deviceId).map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</option>)}
            </select>
            <select aria-label="Camera" value={videoId} onChange={(e) => setVideoId(e.target.value)}>
              <option value="">Default camera</option>
              {devices.filter((d) => d.kind === "videoinput" && d.deviceId).map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Camera"}</option>)}
            </select>
          </div>
        )}
      </div>
      <form className="lobby-side stack" onSubmit={submit}>
        <p className="muted small-text"><code>{props.code}</code></p>
        <h1>{props.title}</h1>
        <p className="muted">
          {people.length === 0 ? "No one is here yet. Joining starts the call." : `${people.map((p) => p.name).join(", ")} ${people.length === 1 ? "is" : "are"} in the call.`}
          {agents.length > 0 && ` ${agents.length} agent${agents.length === 1 ? "" : "s"} attending.`}
        </p>
        <label className="field"><span>Your name in the call</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <button className="primary big" disabled={busy || !ready}>{!ready ? "Starting camera…" : busy ? "Joining…" : people.length ? "Join now" : "Start the call"}</button>
        <button type="button" className="secondary" onClick={() => navigate({ page: "home" })}>Back</button>
      </form>
    </div>
  );
}

type SpeechRecognitionLike = { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };

function Room(props: { code: string; me: Me; meeting: { title: string; code: string; hostId: string; access: string }; isHost: boolean; joined: Joined; peers: Peer[]; callOpen: boolean; initial: { stream: MediaStream | null; mic: boolean; cam: boolean }; onLeft: (why: string) => void; onError: (e: unknown) => void }) {
  const { code, joined, peers } = props;
  const heartbeat = useMutation(api.calls.heartbeat);
  const leave = useMutation(api.calls.leave);
  const end = useMutation(api.calls.end);
  const sendSignal = useMutation(api.signals.send);
  const ack = useMutation(api.signals.ack);
  const caption = useMutation(api.chat.caption);
  const inbox = useQueryState(api.signals.inbox, { peerId: joined.peerId });
  const feed = useQueryState(api.meetings.feed, { code, callNumber: joined.callNumber, limit: 500 });

  const [mic, setMic] = useState(props.initial.mic && Boolean(props.initial.stream));
  const [cam, setCam] = useState(props.initial.cam && Boolean(props.initial.stream));
  const [screen, setScreen] = useState<MediaStream | null>(null);
  const [hand, setHand] = useState(false);
  const [panel, setPanel] = useState<"chat" | "captions" | "people" | "agents" | null>("chat");
  const [captionsOn, setCaptionsOn] = useState(false);
  const [interim, setInterim] = useState("");
  const [, setTick] = useState(0);
  const local = useRef<MediaStream>(props.initial.stream ?? new MediaStream());
  const mesh = useRef<Mesh | null>(null);
  const done = useRef(false);

  // Media mesh for this connection.
  useEffect(() => {
    const m = new Mesh(joined.peerId, (toPeer, kind, sdp) => sendSignal({ fromPeer: joined.peerId, toPeer, kind, sdp }), () => setTick((t) => t + 1));
    mesh.current = m;
    m.setTracks({ audio: local.current.getAudioTracks()[0] ?? null, video: local.current.getVideoTracks()[0] ?? null });
    local.current.getAudioTracks().forEach((t) => (t.enabled = mic));
    return () => m.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined.peerId]);

  const people = peers.filter((p) => p.kind === "person");
  const personIds = people.map((p) => p.id).join(",");
  useEffect(() => {
    mesh.current?.sync(personIds ? personIds.split(",") : []);
  }, [personIds]);

  useEffect(() => {
    const m = mesh.current;
    if (!m || !inbox.data?.length) return;
    void m.receive(inbox.data as any).then((ids) => void (ids.length && ack({ peerId: joined.peerId, ids }).catch(() => {})));
  }, [inbox.data, ack, joined.peerId]);

  // Presence: check in every 15 s and whenever what we share changes.
  const beat = useCallback(async () => {
    if (done.current) return;
    try {
      await retrying(() => heartbeat({ peerId: joined.peerId, mic, cam, screen: Boolean(screen), hand }));
    } catch (error) {
      if ((error as { code?: string }).code === "FAILED_PRECONDITION" || (error as { code?: string }).code === "NOT_FOUND") finish((error as Error).message.includes("ended") ? "The call has ended" : "You were removed from the call");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heartbeat, joined.peerId, mic, cam, screen, hand]);
  useEffect(() => {
    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [beat]);

  // The host ended the call, or this connection was removed.
  const mine = peers.find((p) => p.id === joined.peerId);
  const seenSelf = useRef(false);
  useEffect(() => {
    if (mine) seenSelf.current = true;
    if (!props.callOpen && seenSelf.current) finish("The call has ended");
    else if (!mine && seenSelf.current) finish("You were removed from the call");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.callOpen, Boolean(mine)]);

  function stopAll() {
    local.current.getTracks().forEach((t) => t.stop());
    screen?.getTracks().forEach((t) => t.stop());
    mesh.current?.close();
  }
  function finish(why: string) {
    if (done.current) return;
    done.current = true;
    stopAll();
    props.onLeft(why);
  }

  // Leave when the tab closes or the user navigates away. (StrictMode's dev re-mount is not a departure:
  // the effect runs again before the deferred check.)
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const bye = () => !done.current && void leave({ code, peerId: joined.peerId }).catch(() => {});
    window.addEventListener("pagehide", bye);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", bye);
      setTimeout(() => {
        if (mounted.current || done.current) return;
        bye();
        done.current = true;
        stopAll();
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controls.
  const toggleMic = () => {
    const next = !mic;
    local.current.getAudioTracks().forEach((t) => (t.enabled = next));
    setMic(next);
  };
  const toggleCam = async () => {
    if (cam) {
      local.current.getVideoTracks().forEach((t) => (t.stop(), local.current.removeTrack(t)));
      if (!screen) mesh.current?.setTracks({ video: null });
      setCam(false);
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const track = s.getVideoTracks()[0]!;
      local.current.getVideoTracks().forEach((t) => (t.stop(), local.current.removeTrack(t)));
      local.current.addTrack(track);
      if (!screen) mesh.current?.setTracks({ video: track });
      setCam(true);
    } catch (error) {
      props.onError(new Error(`Camera unavailable: ${(error as Error).message}`));
    }
  };
  const toggleScreen = async () => {
    if (screen) {
      screen.getTracks().forEach((t) => t.stop());
      setScreen(null);
      mesh.current?.setTracks({ video: local.current.getVideoTracks()[0] ?? null });
      return;
    }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = s.getVideoTracks()[0]!;
      track.onended = () => {
        setScreen(null);
        mesh.current?.setTracks({ video: local.current.getVideoTracks()[0] ?? null });
      };
      mesh.current?.setTracks({ video: track });
      setScreen(s);
    } catch {
      /* the person cancelled the picker */
    }
  };
  const doLeave = async () => {
    done.current = true;
    stopAll();
    await leave({ code, peerId: joined.peerId }).catch(() => {});
    props.onLeft("You left the call");
  };
  const endForAll = async () => {
    if (!confirm("End the call for everyone?")) return;
    try {
      await end({ code });
    } catch (error) {
      props.onError(error);
    }
  };

  // Live captions: the browser's speech recognition, sent line by line to the timeline.
  const recognizer = useRef<SpeechRecognitionLike | null>(null);
  const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  useEffect(() => {
    if (!captionsOn || !SpeechRecognition) return;
    const r: SpeechRecognitionLike = new SpeechRecognition();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    let stopped = false;
    r.onresult = (e: any) => {
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = String(e.results[i][0].transcript).trim();
        if (e.results[i].isFinal) {
          if (text && local.current.getAudioTracks().some((t) => t.enabled)) void retrying(() => caption({ peerId: joined.peerId, code, text })).catch(() => {});
        } else partial += text + " ";
      }
      setInterim(partial.trim());
    };
    r.onerror = (e: any) => e?.error === "not-allowed" && ((stopped = true), setCaptionsOn(false), props.onError(new Error("Captions need microphone permission.")));
    r.onend = () => !stopped && setTimeout(() => !stopped && r.start(), 250);
    r.start();
    recognizer.current = r;
    return () => {
      stopped = true;
      r.onend = null;
      r.stop();
      setInterim("");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionsOn]);

  // Time moves reactions along.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const entries = (feed.data?.entries ?? []) as Entry[];
  const now = Date.now();
  const floating = entries.filter((e) => e.kind === "reaction" && now - e.createdAt < 5000);
  const remotes = new Map((mesh.current?.remotes() ?? []).map((r) => [r.peerId, r]));
  const sharer = peers.find((p) => p.screen) ?? null;
  const agents = peers.filter((p) => p.kind === "agent");
  const hands = peers.filter((p) => p.hand);

  const tile = (p: Peer, stage = false) => {
    const self = p.id === joined.peerId;
    const remote = remotes.get(p.id);
    const stream = self ? (screen ?? (cam ? local.current : null)) : (remote?.stream ?? null);
    const showVideo = p.kind === "person" && (self ? Boolean(screen) || cam : p.cam || p.screen);
    return (
      <Tile
        key={p.id + (stage ? ":stage" : "")}
        peer={p}
        self={self}
        stream={stream}
        audio={!self && p.kind === "person" ? (remote?.stream ?? null) : null}
        showVideo={showVideo}
        state={self || p.kind === "agent" ? null : (remote?.state ?? "new")}
        stage={stage}
        mirrored={self && !screen}
        canRemove={props.isHost && !self}
        onRemove={() => void end({ code, peerId: p.id }).catch(props.onError)}
      />
    );
  };

  return (
    <div className="room">
      <div className="room-top">
        <div className="room-title">
          <strong>{props.meeting.title}</strong>
          <span className="muted small-text"><code>{code}</code> · call {joined.callNumber} · {people.length} {people.length === 1 ? "person" : "people"}{agents.length ? `, ${agents.length} agent${agents.length === 1 ? "" : "s"}` : ""}</span>
        </div>
        <button className="secondary small" onClick={() => void navigator.clipboard?.writeText(location.href)}>Copy link</button>
      </div>

      <div className={`room-body ${panel ? "with-panel" : ""}`}>
        <div className="stage-area">
          {sharer ? (
            <div className="stage-layout">
              <div className="stage-main">{tile(sharer, true)}</div>
              <div className="stage-strip">{peers.filter((p) => p.id !== sharer.id).map((p) => tile(p))}</div>
            </div>
          ) : (
            <div className={`grid n${Math.min(peers.length, 9)}`}>{peers.map((p) => tile(p))}</div>
          )}
          <div className="floating" aria-live="polite">
            {floating.map((r) => (
              <span key={r.id} className="float" style={{ left: `${10 + ((r.seq * 37) % 80)}%` }}>{r.text}<small>{r.authorName}</small></span>
            ))}
          </div>
          {(captionsOn || entries.some((e) => e.kind === "caption" && now - e.createdAt < 8000)) && (
            <div className="caption-bar">
              {entries.filter((e) => e.kind === "caption" && now - e.createdAt < 8000).slice(-2).map((e) => (
                <div key={e.id}><b>{e.authorName}:</b> {e.text}</div>
              ))}
              {interim && <div className="muted"><b>You:</b> {interim}…</div>}
            </div>
          )}
        </div>
        {panel && (
          <aside className="panel">
            <div className="tabs" role="tablist">
              {(["chat", "captions", "people", "agents"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={panel === t} className={panel === t ? "on" : ""} onClick={() => setPanel(t)}>
                  {t === "chat" ? "Chat" : t === "captions" ? "Transcript" : t === "people" ? `People (${peers.length})` : "Agents"}
                </button>
              ))}
              <button className="ghost" aria-label="Close panel" onClick={() => setPanel(null)}>×</button>
            </div>
            {panel === "chat" && <ChatPanel code={code} entries={entries.filter((e) => e.kind === "chat" || e.kind === "note" || e.kind === "system")} onError={props.onError} />}
            {panel === "captions" && <Transcript entries={entries.filter((e) => e.kind === "caption")} supported={Boolean(SpeechRecognition)} on={captionsOn} toggle={() => setCaptionsOn(!captionsOn)} />}
            {panel === "people" && <People peers={peers} me={joined.peerId} isHost={props.isHost} remotes={remotes} onRemove={(id) => void end({ code, peerId: id }).catch(props.onError)} />}
            {panel === "agents" && <AgentsPanel code={code} agents={agents} access={props.meeting.access} />}
          </aside>
        )}
      </div>

      <div className="controls">
        <div className="controls-left muted small-text">{hands.length > 0 && `✋ ${hands.map((h) => h.name).join(", ")}`}</div>
        <div className="controls-mid">
          <button className={`round ${mic ? "" : "off"}`} onClick={toggleMic} disabled={!local.current.getAudioTracks().length} aria-label={mic ? "Mute" : "Unmute"} title={mic ? "Mute" : "Unmute"}>{mic ? <MicIcon /> : <MicOffIcon />}</button>
          <button className={`round ${cam ? "" : "off"}`} onClick={() => void toggleCam()} aria-label={cam ? "Turn camera off" : "Turn camera on"} title={cam ? "Camera off" : "Camera on"}>{cam ? <CamIcon /> : <CamOffIcon />}</button>
          <button className={`round ${screen ? "on" : ""}`} onClick={() => void toggleScreen()} aria-label={screen ? "Stop sharing" : "Share screen"} title={screen ? "Stop sharing" : "Share screen"}><ScreenIcon /></button>
          <button className={`round ${hand ? "on" : ""}`} onClick={() => setHand(!hand)} aria-label={hand ? "Lower hand" : "Raise hand"} title={hand ? "Lower hand" : "Raise hand"}>✋</button>
          <Reactions code={code} onError={props.onError} />
          <button className={`round ${captionsOn ? "on" : ""}`} onClick={() => (SpeechRecognition ? setCaptionsOn(!captionsOn) : setPanel("captions"))} aria-label="Live captions" title={SpeechRecognition ? "Live captions" : "Live captions need Chrome or Edge"}>CC</button>
          <button className="round danger" onClick={() => void doLeave()} aria-label="Leave call" title="Leave call"><HangIcon /></button>
        </div>
        <div className="controls-right">
          {props.isHost && <button className="secondary small" onClick={() => void endForAll()}>End for all</button>}
          <button className={`secondary small ${panel ? "active" : ""}`} onClick={() => setPanel(panel ? null : "chat")}>{panel ? "Hide panel" : "Panel"}</button>
        </div>
      </div>
    </div>
  );
}

function Tile(props: { peer: Peer; self: boolean; stream: MediaStream | null; audio: MediaStream | null; showVideo: boolean; state: RTCPeerConnectionState | null; stage: boolean; mirrored: boolean; canRemove: boolean; onRemove: () => void }) {
  const v = useRef<HTMLVideoElement>(null);
  const a = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (v.current && v.current.srcObject !== props.stream) v.current.srcObject = props.stream;
  });
  useEffect(() => {
    if (a.current && a.current.srcObject !== props.audio) a.current.srcObject = props.audio;
  });
  const p = props.peer;
  const connecting = props.state && props.state !== "connected";
  return (
    <div className={`tile ${props.stage ? "stage" : ""} ${p.kind}`} data-peer={p.principalId} data-state={props.state ?? "self"}>
      <video ref={v} autoPlay playsInline muted className={`${props.showVideo ? "" : "hidden"} ${props.mirrored ? "mirror" : ""} ${p.screen ? "contain" : ""}`} />
      {props.audio && <audio ref={a} autoPlay />}
      {!props.showVideo && (p.kind === "agent" ? <div className="avatar agent-avatar" aria-hidden><AgentIcon /></div> : <div className="avatar">{initials(p.name)}</div>)}
      <div className="tile-label">
        {p.hand && <span title="Hand raised">✋</span>}
        {p.kind === "person" && !p.mic && <span className="muted-icon" title="Muted"><MicOffIcon /></span>}
        <span>{p.name}{props.self ? " (you)" : ""}</span>
        {p.kind === "agent" && <span className="badge agent-badge">AI agent</span>}
        {p.screen && <span className="badge">Presenting</span>}
      </div>
      {connecting && <div className="tile-state">{props.state === "failed" ? "Reconnecting…" : "Connecting…"}</div>}
      {props.canRemove && <button className="tile-remove" onClick={props.onRemove} title={`Remove ${p.name}`} aria-label={`Remove ${p.name}`}>×</button>}
    </div>
  );
}

function ChatPanel({ code, entries, onError }: { code: string; entries: Entry[]; onError: (e: unknown) => void }) {
  const send = useMutation(api.chat.send);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [entries.length]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const t = text;
    setText("");
    try {
      await retrying(() => send({ code, text: t }));
    } catch (error) {
      setText(t);
      onError(error);
    }
  };
  return (
    <div className="panel-body">
      <div className="messages" ref={list} role="log">
        {entries.length === 0 && <p className="muted small-text">Messages are kept with the meeting and shown in its recap.</p>}
        {entries.map((e) =>
          e.kind === "system" ? (
            <div key={e.id} className="system-line">{e.text} · {clock(e.createdAt)}</div>
          ) : (
            <div key={e.id} className={`message ${e.kind} ${e.authorKind}`}>
              <div className="message-meta">
                <b>{e.authorName}</b>
                {e.authorKind === "agent" && <span className="badge agent-badge">AI agent</span>}
                {e.kind === "note" && <span className="badge">Note</span>}
                <span className="muted">{clock(e.createdAt)}</span>
              </div>
              <div className="message-text">{e.text}</div>
            </div>
          ),
        )}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Send a message" aria-label="Message" maxLength={4000} />
        <button className="primary small" disabled={!text.trim()}>Send</button>
      </form>
    </div>
  );
}

function Transcript({ entries, supported, on, toggle }: { entries: Entry[]; supported: boolean; on: boolean; toggle: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [entries.length]);
  return (
    <div className="panel-body">
      <div className="panel-note">
        {supported ? (
          <>
            <button className={on ? "primary small" : "secondary small"} onClick={toggle}>{on ? "Stop captioning me" : "Caption me"}</button>
            <span className="muted small-text">Each person's browser transcribes their own speech (Chrome sends audio to its speech service). Agents read this transcript.</span>
          </>
        ) : (
          <span className="muted small-text">This browser has no speech recognition. Others using Chrome or Edge can still caption themselves.</span>
        )}
      </div>
      <div className="messages" ref={list} role="log">
        {entries.length === 0 && <p className="muted small-text">No captions yet.</p>}
        {entries.map((e) => (
          <div key={e.id} className="caption-line"><span className="muted">{clock(e.createdAt)}</span> <b>{e.authorName}</b> {e.text}</div>
        ))}
      </div>
    </div>
  );
}

function People({ peers, me, isHost, remotes, onRemove }: { peers: Peer[]; me: string; isHost: boolean; remotes: Map<string, { state: RTCPeerConnectionState }>; onRemove: (id: string) => void }) {
  return (
    <div className="panel-body">
      <ul className="people">
        {peers.map((p) => (
          <li key={p.id}>
            <span className={`avatar tiny ${p.kind === "agent" ? "agent-avatar" : ""}`}>{p.kind === "agent" ? <AgentIcon /> : initials(p.name)}</span>
            <span className="people-name">
              {p.name}{p.id === me ? " (you)" : ""} {p.kind === "agent" && <span className="badge agent-badge">AI agent</span>}
              <span className="muted small-text">
                {p.kind === "agent" ? "attending: reads the transcript and chat" : [p.mic ? "mic on" : "muted", p.cam ? "camera on" : null, p.screen ? "presenting" : null, p.id !== me ? remotes.get(p.id)?.state ?? "connecting" : null].filter(Boolean).join(" · ")}
              </span>
            </span>
            {p.hand && <span title="Hand raised">✋</span>}
            {isHost && p.id !== me && <button className="secondary small" onClick={() => onRemove(p.id)}>Remove</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How an agent attends: MCP at this app's /mcp, with an agent session or API key. */
function AgentsPanel({ code, agents, access }: { code: string; agents: Peer[]; access: string }) {
  const origin = location.origin;
  const steps = useMemo(
    () => [
      { label: "1. Give the agent an identity (in the project folder; prints a token)", cmd: `npx feltkit session create --type agent --id claude --role agent` },
      { label: "2. Connect it over MCP (Claude Code shown; any MCP client works)", cmd: `claude mcp add --transport http meetings ${origin}/mcp --header "Authorization: Bearer <token>"` },
      { label: "3. Ask it to attend", cmd: `Join meeting ${code} with meetings_join, follow what is said with meetings_feed (pass the returned next as after), answer in chat with chat_send, and add a summary and action items with notes_add when we wrap up. Call meetings_join again every 20 seconds to stay present.` },
    ],
    [origin, code],
  );
  return (
    <div className="panel-body scroll">
      <div className="panel-note stack">
        <p className="small-text">
          {agents.length ? `${agents.map((a) => a.name).join(", ")} ${agents.length === 1 ? "is" : "are"} attending.` : "No agents are attending."} Agents join as participants without media: they read the live transcript and chat, post messages, and leave notes for the recap. They never keep a call open on their own.
        </p>
        {access === "invited" && <p className="small-text warn-text">This meeting is invite-only: the host must invite the agent's id (e.g. <code>claude</code>).</p>}
        {steps.map((s) => (
          <div key={s.label} className="stack">
            <span className="small-text muted">{s.label}</span>
            <code className="block">{s.cmd}</code>
            <button className="secondary small" onClick={() => void navigator.clipboard?.writeText(s.cmd)}>Copy</button>
          </div>
        ))}
        <p className="small-text muted">In production, issue an API key (Studio → Services → API keys); keys hold the agent role. MCP tools the agent gets: meetings_list, meetings_get, meetings_join, meetings_feed, meetings_recap, meetings_leave, chat_send, chat_react, notes_add.</p>
      </div>
    </div>
  );
}

function Reactions({ code, onError }: { code: string; onError: (e: unknown) => void }) {
  const react = useMutation(api.chat.react);
  const [open, setOpen] = useState(false);
  return (
    <div className="reactions">
      <button className={`round ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-label="React" title="React">☺</button>
      {open && (
        <div className="reaction-menu">
          {REACTIONS.map((r) => (
            <button key={r} onClick={() => (setOpen(false), void retrying(() => react({ code, emoji: r })).catch(onError))} aria-label={`React ${r}`}>{r}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

const I = (d: string) => () => <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden><path fill="currentColor" d={d} /></svg>;
const MicIcon = I("M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z");
const MicOffIcon = I("M19 11h-2a5 5 0 0 1-.7 2.56l1.46 1.46A6.96 6.96 0 0 0 19 11zM15 11V5a3 3 0 0 0-5.94-.6L15 10.34zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.52 2.59l1.65 1.65A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 3.32-1.33L19.73 21 21 19.73z");
const CamIcon = I("M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z");
const CamOffIcon = I("M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.82L21 17.18zM3.27 2 2 3.27 4.73 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 .55-.17L19.73 21 21 19.73z");
const ScreenIcon = I("M20 4H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h5v2h6v-2h5a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 12H4V6h16zM11 8l-4 4h3v3h2v-3h3z");
const HangIcon = I("M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28a11.27 11.27 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z");
const AgentIcon = I("M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73A2 2 0 0 1 12 2zM7.5 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z");
