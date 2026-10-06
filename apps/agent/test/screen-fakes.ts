import type { DisplayInfo, NativeDriver } from "../src/computer/native.js";
import type { IceServer, PeerFactory, PeerState, ScreenChannel, ScreenPeer } from "../src/screen/peer.js";

/** Test doubles for remote screen: no real screen, input or network is ever touched. */

export type Op = [string, ...unknown[]];

export const fakeDriver = (displays?: DisplayInfo[]) => {
  const ops: Op[] = [];
  const shown: DisplayInfo[] = displays ?? [
    { index: 0, name: "Built-in", x: 0, y: 0, width: 1000, height: 500, scaleFactor: 1, primary: true },
  ];
  const driver: NativeDriver = {
    displays: () => shown,
    capture: async (i) => {
      ops.push(["capture", i]);
      const d = shown[i]!;
      return { width: d.width, height: d.height, rgba: new Uint8Array(d.width * d.height * 4).fill(90) };
    },
    move: (x, y) => void ops.push(["move", x, y]),
    click: (b, dbl) => void ops.push(["click", b, dbl]),
    button: (down, b) => void ops.push(["button", down, b]),
    scroll: (dx, dy) => void ops.push(["scroll", dx, dy]),
    type: (t) => void ops.push(["type", t]),
    key: (k, m) => void ops.push(["key", k, m]),
    windows: () => [],
    focus: async () => undefined,
  };
  return { driver, ops };
};

export class FakeChannel implements ScreenChannel {
  readonly sent: (Buffer | string)[] = [];
  closed = false;
  buffered = 0;
  #open: (() => void)[] = [];
  #close: (() => void)[] = [];
  #msg: ((d: Buffer | string) => void)[] = [];

  constructor(
    readonly label: string,
    readonly opts: { ordered: boolean; maxRetransmits?: number },
  ) {}

  send(d: Buffer | string) {
    if (this.closed) throw new Error("closed");
    this.sent.push(d);
  }
  bufferedAmount() {
    return this.buffered;
  }
  onOpen(fn: () => void) {
    this.#open.push(fn);
  }
  onClose(fn: () => void) {
    this.#close.push(fn);
  }
  onMessage(fn: (d: Buffer | string) => void) {
    this.#msg.push(fn);
  }
  close() {
    this.closed = true;
  }
  /** The remote end: the channel opens. */
  open() {
    for (const f of this.#open) f();
  }
  /** The remote end sends a message. */
  deliver(m: Buffer | string) {
    for (const f of this.#msg) f(m);
  }
  remoteClose() {
    for (const f of this.#close) f();
  }
}

export class FakePeer implements ScreenPeer {
  readonly channels: FakeChannel[] = [];
  answer: string | null = null;
  readonly ice: unknown[] = [];
  closed = false;
  #state: ((s: PeerState) => void)[] = [];
  #remote: ((c: ScreenChannel) => void)[] = [];

  constructor(readonly iceServers: IceServer[]) {}

  createChannel(label: string, opts: { ordered: boolean; maxRetransmits?: number }) {
    const c = new FakeChannel(label, opts);
    this.channels.push(c);
    return c;
  }
  async createOffer() {
    return "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB\r\n";
  }
  async setAnswer(sdp: string) {
    this.answer = sdp;
  }
  async addIce(c: unknown) {
    this.ice.push(c);
  }
  onState(fn: (s: PeerState) => void) {
    this.#state.push(fn);
  }
  onRemoteChannel(fn: (c: ScreenChannel) => void) {
    this.#remote.push(fn);
  }
  close() {
    this.closed = true;
  }
  /** The browser opens a channel of its own (the agent must refuse it). */
  remoteOpens(label: string): FakeChannel {
    const c = new FakeChannel(label, { ordered: true });
    for (const f of this.#remote) f(c);
    return c;
  }
  setState(s: PeerState) {
    for (const f of this.#state) f(s);
  }
  channel(label: string) {
    return this.channels.find((c) => c.label === label);
  }
}

export const fakePeers = () => {
  const peers: FakePeer[] = [];
  const factory: PeerFactory = async ({ iceServers }) => {
    const p = new FakePeer(iceServers);
    peers.push(p);
    return p;
  };
  return { factory, peers };
};

/** Manual timers: `every`/`after` record callbacks the test fires. */
export const manualTimers = () => {
  const loops: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timeouts: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    loops,
    timeouts,
    every: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      loops.push(t);
      return { clear: () => void (t.cleared = true) };
    },
    after: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timeouts.push(t);
      return { clear: () => void (t.cleared = true) };
    },
  };
};

export const tick = () => new Promise((r) => setTimeout(r, 0));
