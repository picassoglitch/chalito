/**
 * The WebRTC peer on the device side of a screen session. Everything above this file talks to
 * `ScreenPeer`, which the tests replace; production uses `werift` (a pure-TypeScript WebRTC
 * stack: ICE, DTLS, SCTP data channels), loaded on first use so an agent that never streams never
 * loads it. Pure TypeScript matters here: the agent ships as one `bun build --compile` binary per
 * platform, and werift needs no per-platform prebuilds (docs/adr/0021-remote-screen.md).
 *
 * The agent is always the offerer and creates every data channel itself; a channel the remote
 * end opens is closed at once (`onRemoteChannel`). Signaling is non-trickle on the agent side:
 * the offer carries every gathered candidate, so one sealed message is enough.
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Public STUN only, until the owner provisions TURN (owner action, ADR 0021): peer-to-peer works
 * on most home and office networks; symmetric NATs and strict firewalls need a relay.
 */
export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * ICE servers from `CHALITO_ICE_SERVERS` (JSON array of {urls, username?, credential?}), used once
 * the owner runs TURN. A bad value falls back to the defaults. A relay never sees content: DTLS
 * runs end to end between the browser and this device.
 */
export const iceServersFrom = (env: Record<string, string | undefined>): IceServer[] => {
  const raw = env.CHALITO_ICE_SERVERS;
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) return DEFAULT_ICE_SERVERS;
    const ok = parsed.every((s: unknown) => {
      if (!s || typeof s !== "object") return false;
      const { urls, username, credential } = s as Record<string, unknown>;
      const list = Array.isArray(urls) ? urls : [urls];
      return (
        list.length > 0 &&
        list.every((u) => typeof u === "string" && /^(stun|stuns|turn|turns):[^\s]{1,200}$/.test(u)) &&
        (username === undefined || typeof username === "string") &&
        (credential === undefined || typeof credential === "string")
      );
    });
    return ok ? (parsed as IceServer[]) : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
};

export interface ScreenChannel {
  readonly label: string;
  send(data: Buffer | string): void;
  bufferedAmount(): number;
  onOpen(fn: () => void): void;
  onClose(fn: () => void): void;
  onMessage(fn: (data: Buffer | string) => void): void;
  close(): void;
}

export type PeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

export interface ScreenPeer {
  createChannel(label: string, opts: { ordered: boolean; maxRetransmits?: number }): ScreenChannel;
  /** Creates the offer, waits for ICE gathering (bounded) and returns the full SDP. */
  createOffer(): Promise<string>;
  setAnswer(sdp: string): Promise<void>;
  addIce(c: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void>;
  onState(fn: (s: PeerState) => void): void;
  /** A data channel the remote end opened: the session closes it. */
  onRemoteChannel(fn: (ch: ScreenChannel) => void): void;
  close(): void;
}

export type PeerFactory = (cfg: { iceServers: IceServer[] }) => Promise<ScreenPeer>;

/** How long the offer waits for ICE gathering before going out with what it has. */
export const GATHER_WAIT_MS = 5000;

type Sub<A extends unknown[]> = { subscribe(fn: (...a: A) => void): unknown };
interface WeriftChannel {
  label: string;
  readyState: string;
  bufferedAmount: number;
  send(d: Buffer | string): void;
  close(): void;
  stateChanged: Sub<[string]>;
  onMessage: Sub<[Buffer | string]>;
}
interface WeriftPc {
  iceGatheringState: string;
  localDescription?: { sdp: string } | null;
  createDataChannel(label: string, o: { ordered: boolean; maxRetransmits?: number }): WeriftChannel;
  createOffer(): Promise<unknown>;
  setLocalDescription(d: unknown): Promise<unknown>;
  setRemoteDescription(d: { type: "answer"; sdp: string }): Promise<void>;
  addIceCandidate(c: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): Promise<void>;
  iceGatheringStateChange: Sub<[string]>;
  connectionStateChange: Sub<[PeerState]>;
  onDataChannel: Sub<[WeriftChannel]>;
  close(): Promise<void>;
}

const wrap = (c: WeriftChannel): ScreenChannel => ({
  label: c.label,
  send: (d) => c.send(d),
  bufferedAmount: () => c.bufferedAmount,
  onOpen: (fn) => {
    if (c.readyState === "open") fn();
    c.stateChanged.subscribe((s) => s === "open" && fn());
  },
  onClose: (fn) => c.stateChanged.subscribe((s) => s === "closed" && fn()),
  onMessage: (fn) => c.onMessage.subscribe(fn),
  close: () => {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  },
});

/** The production peer (werift). */
export const weriftPeer: PeerFactory = async ({ iceServers }) => {
  const mod = (await import("werift")) as unknown as {
    RTCPeerConnection: new (cfg: { iceServers: IceServer[] }) => WeriftPc;
  };
  const pc = new mod.RTCPeerConnection({ iceServers });
  return {
    createChannel: (label, opts) => wrap(pc.createDataChannel(label, opts)),
    createOffer: async () => {
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== "complete")
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, GATHER_WAIT_MS);
          pc.iceGatheringStateChange.subscribe((s) => {
            if (s === "complete") {
              clearTimeout(t);
              resolve();
            }
          });
        });
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("no local description");
      return sdp;
    },
    setAnswer: (sdp) => pc.setRemoteDescription({ type: "answer", sdp }),
    addIce: (c) =>
      pc.addIceCandidate({
        candidate: c.candidate,
        ...(c.sdpMid != null ? { sdpMid: c.sdpMid } : {}),
        ...(c.sdpMLineIndex != null ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
      }),
    onState: (fn) => pc.connectionStateChange.subscribe(fn),
    onRemoteChannel: (fn) => pc.onDataChannel.subscribe((c) => fn(wrap(c))),
    close: () => void pc.close().catch(() => undefined),
  };
};
