/**
 * Browser-to-browser media for one call: a full mesh of RTCPeerConnections.
 *
 * Deterministic roles, so no negotiation races: of each pair, the connection with the smaller
 * peer id offers and the other answers. ICE candidates are gathered before the offer/answer is
 * sent, so each pair exchanges exactly two signals (stored in FeltDB until read). Every
 * connection has one audio and one video transceiver from the start; turning the camera off or
 * sharing the screen only swaps the outgoing track (replaceTrack), never renegotiates.
 *
 * A mesh suits small calls (each person uploads to everyone else). Larger calls need an SFU;
 * this module is the one place that would change.
 */

export type Signal = { id: string; fromPeer: string; kind: "offer" | "answer"; sdp: string };
type Send = (toPeer: string, kind: "offer" | "answer", sdp: string) => Promise<unknown>;

export type Remote = { peerId: string; stream: MediaStream; state: RTCPeerConnectionState };

/** How long an offered connection may take to come up before it is offered again. */
const OFFER_TIMEOUT_MS = 15_000;

type Conn = { pc: RTCPeerConnection; stream: MediaStream; listed: boolean; createdAt: number };

/** The default when the server issues none (no TURN provider): STUN only, or VITE_ICE_SERVERS. */
function defaultIceServers(): RTCIceServer[] {
  const configured = (import.meta as any).env?.VITE_ICE_SERVERS as string | undefined;
  if (configured) {
    try {
      return JSON.parse(configured);
    } catch {
      console.warn("VITE_ICE_SERVERS is not JSON; using the default STUN server.");
    }
  }
  // STUN finds each browser's public address. Peers behind strict NATs also need a TURN server
  // (set VITE_ICE_SERVERS='[{"urls":"turn:…","username":"…","credential":"…"}]').
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

function gathered(pc: RTCPeerConnection, maxMs = 2500): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, maxMs); // an unreachable STUN server must not stall the call
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export class Mesh {
  private conns = new Map<string, Conn>();
  private seen = new Set<string>();
  private tracks: { audio: MediaStreamTrack | null; video: MediaStreamTrack | null } = { audio: null, video: null };
  private closed = false;

  constructor(
    readonly self: string,
    private send: Send,
    private onChange: () => void,
    /** From the server (`media:iceServers`): STUN plus short-lived TURN credentials when a provider is configured. */
    private ice: RTCIceServer[] = defaultIceServers(),
  ) {}

  /** What each pair connected over, from the selected candidate pair: host, srflx, prflx or relay. */
  async paths(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [peerId, c] of this.conns) {
      const stats = await c.pc.getStats();
      stats.forEach((r: any) => {
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") {
          const local = stats.get(r.localCandidateId) as any;
          const remote = stats.get(r.remoteCandidateId) as any;
          out[peerId] = `${local?.candidateType}/${local?.protocol}${local?.relayProtocol ? `(relay over ${local.relayProtocol})` : ""}→${remote?.candidateType}`;
        }
      });
    }
    return out;
  }

  remotes(): Remote[] {
    return [...this.conns.entries()].map(([peerId, c]) => ({ peerId, stream: c.stream, state: c.pc.connectionState }));
  }

  /** The outgoing tracks (null: send nothing on that kind). Applies to every connection at once. */
  setTracks(next: { audio?: MediaStreamTrack | null; video?: MediaStreamTrack | null }) {
    this.tracks = { ...this.tracks, ...next };
    for (const c of this.conns.values()) this.attach(c.pc);
  }

  /** The people's connections in the call right now (agents excluded: they carry no media). */
  sync(peerIds: string[]) {
    if (this.closed) return;
    const want = new Set(peerIds.filter((id) => id !== this.self));
    for (const id of want) {
      const existing = this.conns.get(id);
      if (existing) existing.listed = true;
      else if (this.self < id) void this.offer(id);
    }
    for (const [id, c] of this.conns) {
      // Close a connection whose peer left. One created from an offer that arrived before the
      // peer list caught up is given 20 s to appear in it.
      if (!want.has(id) && (c.listed || Date.now() - c.createdAt > 20_000)) this.drop(id);
    }
  }

  /** Offers and answers addressed to this connection. Returns the ids handled (to delete). */
  async receive(signals: Signal[]): Promise<string[]> {
    const handled: string[] = [];
    for (const sig of signals) {
      if (this.seen.has(sig.id)) continue;
      this.seen.add(sig.id);
      handled.push(sig.id);
      try {
        if (sig.kind === "offer") await this.answer(sig.fromPeer, sig.sdp);
        else {
          const c = this.conns.get(sig.fromPeer);
          if (c && c.pc.signalingState === "have-local-offer") await c.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
        }
      } catch (error) {
        console.warn(`Signal from ${sig.fromPeer} failed`, error);
      }
    }
    return handled;
  }

  close() {
    this.closed = true;
    for (const id of [...this.conns.keys()]) this.drop(id);
  }

  private create(peerId: string, listed: boolean): Conn {
    this.drop(peerId);
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const stream = new MediaStream();
    const conn: Conn = { pc, stream, listed, createdAt: Date.now() };
    pc.ontrack = (e) => {
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      this.onChange();
      // The offering side restarts a failed connection; the answering side waits for its new offer.
      if (pc.connectionState === "failed" && this.self < peerId && this.conns.get(peerId)?.pc === pc && !this.closed) {
        setTimeout(() => this.conns.get(peerId)?.pc === pc && void this.offer(peerId), 1000);
      }
    };
    this.conns.set(peerId, conn);
    this.onChange();
    return conn;
  }

  private attach(pc: RTCPeerConnection) {
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track?.kind as "audio" | "video" | undefined;
      if (!kind || t.currentDirection === "stopped") continue;
      if (t.direction !== "sendrecv") t.direction = "sendrecv";
      if (t.sender.track !== this.tracks[kind]) void t.sender.replaceTrack(this.tracks[kind]).catch(() => {});
    }
  }

  private async offer(peerId: string) {
    const { pc } = this.create(peerId, true);
    pc.addTransceiver("audio", { direction: "sendrecv" });
    pc.addTransceiver("video", { direction: "sendrecv" });
    this.attach(pc);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    if (this.conns.get(peerId)?.pc !== pc) return;
    await this.send(peerId, "offer", pc.localDescription!.sdp).catch((e) => console.warn("Offer not sent", e));
    // An offer or answer can be lost (the other side reloaded, a send failed): offer again if this
    // connection has not come up in time. The answering side replaces its connection on each offer.
    setTimeout(() => {
      if (!this.closed && this.conns.get(peerId)?.pc === pc && pc.connectionState !== "connected") void this.offer(peerId);
    }, OFFER_TIMEOUT_MS);
  }

  private async answer(peerId: string, sdp: string) {
    const listed = this.conns.get(peerId)?.listed ?? false;
    const { pc } = this.create(peerId, listed);
    await pc.setRemoteDescription({ type: "offer", sdp });
    this.attach(pc);
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    if (this.conns.get(peerId)?.pc !== pc) return;
    await this.send(peerId, "answer", pc.localDescription!.sdp).catch((e) => console.warn("Answer not sent", e));
  }

  private drop(peerId: string) {
    const c = this.conns.get(peerId);
    if (!c) return;
    this.conns.delete(peerId);
    c.pc.ontrack = null;
    c.pc.onconnectionstatechange = null;
    c.pc.close();
    this.onChange();
  }
}
