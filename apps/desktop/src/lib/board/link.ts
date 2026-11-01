import { ApprovalConsoleCommand, type ApprovalConsoleFrame } from "@chalito/protocol";
import type { ApprovalDisplayTransport } from "@chalito/client";
import { CARD_FRAMES, type BoardCard } from "./card.js";
import {
  clampMs,
  hostHello,
  parseBoardLine,
  type BoardActivityHint,
  type BoardAlert,
  type BoardHello,
  type BoardMessage,
  type BoardMood,
  type BoardPort,
  type BoardStatus,
} from "./protocol.js";
import type { BoardSessions } from "./sessions.js";
import { hmacKey, keyIdOf, newPairing, verifyDecideMac, type PairStore, type PairedBoard } from "./pairing.js";
import { memoryCardErrors, type CardErrorChannel } from "./card-errors.js";

/** How often an unchanged sessions overview is sent again, so a board that lost the link catches up. */
export const SESSIONS_REFRESH_MS = 15_000;
/** BOARD_LINK: at most this many raw bytes a card-chunk. */
export const CHUNK_BYTES = 2048;
/** No pair-ok or pair-cancel in this long: the pairing didn't happen. */
export const PAIR_TIMEOUT_MS = 60_000;
/** BOARD_LINK pairing wants a 1.5 s hold after the code shows: a pair-ok sooner wasn't a person. */
export const PAIR_MIN_MS = 1500;
/** A failed card is tried again after this, doubling up to CARD_RETRY_MAX_MS. */
export const CARD_RETRY_MS = 5000;
const CARD_RETRY_MAX_MS = 5 * 60_000;
const HELLO_RETRY_MAX_MS = 10_000;

/** "save-failed": the board took the secret but this computer couldn't keep it. */
export type PairResult = "paired" | "cancelled" | "timeout" | "failed" | "save-failed";
/** "board-unconfirmed": forgotten here, but the pair-reset didn't reach the board. */
export type ForgetResult = "forgotten" | "board-unconfirmed" | "failed";
/** Approval-screen trouble the person should hear about in the panel. */
export type ApprovalProblem = "send_failed" | "phone_required" | "write_failed";

export interface BoardLinkOptions {
  /** How long to wait for each card-progress / card-ack. */
  replyMs?: number;
  /** Upload attempts per card before giving up (until the card changes or the board says hello again). */
  attempts?: number;
  /** How long a pairing waits for the person (PAIR_TIMEOUT_MS). */
  pairMs?: number;
  /** A pair-ok sooner than this after pair-begin is refused (PAIR_MIN_MS). */
  minPairMs?: number;
  /** First wait before trying a failed card again (CARD_RETRY_MS). */
  retryMs?: number;
  /** First wait before resending a host hello that failed to go out. */
  helloRetryMs?: number;
  /** Where a card failure is shared with the other windows. */
  cardErrors?: CardErrorChannel;
  /** This window uploads the card: a card error left by the last run is cleared on start. */
  uploadsCard?: boolean;
  /** Approval frames that may fail in a row while connected before the screen is stopped. */
  frameFailures?: number;
}

export interface BoardSnapshot {
  status: BoardStatus;
  /** The board's last hello while connected: it's ready for messages. */
  hello: BoardHello | null;
  /** The card upload: what's going on with the owner's card on the board. */
  card: "none" | "converting" | "uploading" | "stored" | "failed";
  /** This computer holds a board's pairing secret. */
  hasPairing: boolean;
  /** The connected board is the one we're paired with: only then does it get anything. */
  paired: boolean;
  /** A pairing in progress: the code the board must show. */
  pairing: { code: string } | null;
  /** Decides dropped for a missing or wrong mac since the app started. */
  rejected: number;
  /** Why the card didn't reach the board, from whichever window uploads it; null once it does. */
  cardError: string | null;
  /** The saved pairing couldn't be read (so the board looks unpaired). */
  pairingError: string | null;
  /** The approvals screen's last problem, until a later result clears it. */
  approvalProblem: ApprovalProblem | null;
}

/** A card the board should show; `convert` runs at most once per id (the link caches it). */
export interface CardSource {
  id: string;
  convert: () => Promise<BoardCard>;
}

class Aborted extends Error {}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const base64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The desktop's side of docs/BOARD_LINK.md: handshake, card upload, mood/alert, pet tricks and
 * approval buttons. Silent while no board is plugged in. */
export class BoardLink {
  readonly #port: BoardPort;
  readonly #replyMs: number;
  readonly #attempts: number;
  readonly #pairMs: number;
  readonly #store: PairStore;
  readonly #minPairMs: number;
  readonly #retryMs: number;
  readonly #helloRetryMs: number;
  readonly #cardErrors: CardErrorChannel;
  readonly #uploadsCard: boolean;
  readonly #frameFailures: number;
  #cardRetries = 0;
  #cardRetry: ReturnType<typeof setTimeout> | undefined;
  #helloRetries = 0;
  #helloRetry: ReturnType<typeof setTimeout> | undefined;
  #pairedBoard: PairedBoard | null = null;
  /** Board commands are handled one at a time, in order (a decide's mac check is async). */
  #commandChain: Promise<void> = Promise.resolve();
  #snap: BoardSnapshot = {
    status: { state: "absent" },
    hello: null,
    card: "none",
    hasPairing: false,
    paired: false,
    pairing: null,
    rejected: 0,
    cardError: null,
    pairingError: null,
    approvalProblem: null,
  };
  readonly #listeners = new Set<() => void>();
  readonly #pets = new Set<(trick: string) => void>();
  readonly #commands = new Set<(c: ApprovalConsoleCommand) => void>();
  readonly #waiters = new Set<(m: BoardMessage) => void>();
  #offs: (() => void)[] = [];
  #source: CardSource | null = null;
  #converted: { id: string; card: Promise<BoardCard> } | null = null;
  /** Bumped on every reason to stop an upload (unplug, new card, new hello). */
  #epoch = 0;
  #uploading = false;
  /** Something changed during an upload: look again once it ends. */
  #again = false;
  /** What the agents are doing, for the board's idle activities; resent to each newly paired hello. */
  #hint: BoardActivityHint | null = null;
  #hintSent: BoardActivityHint | null = null;
  /** The latest sessions overview, and the line last sent (resent after each hello and now and then). */
  #sessions: string | null = null;
  #sessionsSent: { line: string; at: number } | null = null;
  /** The offset our last hello carried: a DST switch or travel sends a fresh one. */
  #tzSent: number | null = null;

  constructor(port: BoardPort, store: PairStore, opts: BoardLinkOptions = {}) {
    this.#port = port;
    this.#store = store;
    this.#replyMs = opts.replyMs ?? 3000;
    this.#attempts = opts.attempts ?? 3;
    this.#pairMs = opts.pairMs ?? PAIR_TIMEOUT_MS;
    this.#minPairMs = opts.minPairMs ?? PAIR_MIN_MS;
    this.#retryMs = opts.retryMs ?? CARD_RETRY_MS;
    this.#helloRetryMs = opts.helloRetryMs ?? 500;
    this.#cardErrors = opts.cardErrors ?? memoryCardErrors();
    this.#uploadsCard = opts.uploadsCard ?? false;
    this.#frameFailures = opts.frameFailures ?? 3;
  }

  getSnapshot = (): BoardSnapshot => this.#snap;
  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  };
  /** A board answered, paired or not (it may only get hello and pairing messages). */
  get found(): boolean {
    return this.#snap.status.state === "connected" && this.#snap.hello !== null;
  }
  /** The paired board is connected: everything else is allowed. */
  get ready(): boolean {
    return this.found && this.#snap.paired;
  }

  start(): void {
    if (this.#offs.length) return;
    let heard = false;
    this.#offs.push(
      this.#port.onStatus((s) => {
        heard = true;
        this.#onStatus(s);
      }),
    );
    this.#offs.push(this.#port.onLine((l) => this.#onLine(l)));
    this.#offs.push(this.#store.onChange(() => void this.#loadPairing()));
    const cardError = () => this.#set({ cardError: this.#cardErrors.get() });
    this.#offs.push(this.#cardErrors.onChange(cardError));
    // LCD — localStorage outlives the app; a new launch hasn't failed anything yet.
    if (this.#uploadsCard) this.#cardErrors.set(null);
    cardError();
    void this.#loadPairing();
    // The current status for a window opened after the board; an event since then is newer.
    void this.#port.status().then(
      (s) => heard || this.#onStatus(s),
      () => undefined,
    );
  }

  stop(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
    this.#epoch++;
    clearTimeout(this.#cardRetry);
    clearTimeout(this.#helloRetry);
    this.#helloRetry = undefined;
  }

  /** The approvals screen's latest trouble (null: it worked again). */
  reportApproval(problem: ApprovalProblem | null): void {
    if (problem !== this.#snap.approvalProblem) this.#set({ approvalProblem: problem });
  }

  /** A trick the board played on a click (mirror it on the desktop pet). */
  onPet(fn: (trick: string) => void): () => void {
    this.#pets.add(fn);
    return () => void this.#pets.delete(fn);
  }

  /** A button on the approvals screen, already validated as an ApprovalConsoleCommand. */
  onCommand(fn: (c: ApprovalConsoleCommand) => void): () => void {
    this.#commands.add(fn);
    return () => void this.#commands.delete(fn);
  }

  mood(mood: BoardMood, ms: number): void {
    if (this.ready) void this.#write({ v: 1, type: "mood", mood, ms: clampMs(ms) }).catch(() => undefined);
  }

  /** Agents busy or not: the board prefers its "working" activity while they are. Sent on change. */
  activity(hint: BoardActivityHint): void {
    this.#hint = hint;
    if (this.found && this.#tzSent !== hostHello().tz) this.#writeHello();
    this.#sendHint();
  }

  /** The double-click screen's overview when nothing waits on the person. Sent on change, after each
   * hello, and every SESSIONS_REFRESH_MS (the board forgets it when the link drops). */
  sessions(overview: BoardSessions, now = Date.now()): void {
    this.#sessions = JSON.stringify({ v: 1, type: "sessions", items: overview.items, more: overview.more });
    this.#sendSessions(now);
  }

  #sendSessions(now = Date.now()): void {
    const line = this.#sessions;
    const last = this.#sessionsSent;
    if (!this.ready || !line || (last?.line === line && now - last.at < SESSIONS_REFRESH_MS)) return;
    this.#sessionsSent = { line, at: now };
    void this.#port.write(line).catch(() => {
      if (this.#sessionsSent?.line === line) this.#sessionsSent = null;
    });
  }

  #writeHello(): void {
    const hello = hostHello();
    this.#tzSent = hello.tz;
    const status = this.#snap.status;
    void this.#write(hello).then(
      () => void (this.#helloRetries = 0),
      (e) => {
        console.warn("board: couldn't send hello", e);
        // Only the board's answer makes it usable: try again while it's still the same connection.
        if (this.#snap.status !== status || this.#snap.hello || this.#helloRetry || !this.#offs.length) return;
        const ms = Math.min(this.#helloRetryMs * 2 ** this.#helloRetries++, HELLO_RETRY_MAX_MS);
        this.#helloRetry = setTimeout(() => {
          this.#helloRetry = undefined;
          if (this.#snap.status === status && !this.#snap.hello) this.#writeHello();
        }, ms);
      },
    );
  }

  #sendHint(): void {
    if (!this.ready || !this.#hint || this.#hint === this.#hintSent) return;
    this.#hintSent = this.#hint;
    void this.#write({ v: 1, type: "activity", hint: this.#hint }).catch(() => {
      if (this.#hintSent === this.#hint) this.#hintSent = null;
    });
  }

  alert(level: BoardAlert, ms?: number): void {
    const line = { v: 1, type: "alert", level, ...(ms === undefined ? {} : { ms: clampMs(ms) }) };
    if (this.ready) void this.#write(line).catch(() => undefined);
  }

  /** The card the board should show (null: leave whatever it has). Uploads when it differs. */
  setCard(source: CardSource | null): void {
    if (source?.id === this.#source?.id) {
      // The same card after a failure (the sky tick): try again now rather than wait for the backoff.
      if (source && this.#snap.card === "failed") {
        clearTimeout(this.#cardRetry);
        this.#source = source;
        void this.#sync();
      }
      return;
    }
    this.#source = source;
    this.#epoch++;
    this.#cardRetries = 0;
    clearTimeout(this.#cardRetry);
    this.#set({ card: "none" });
    void this.#sync();
  }

  #cardFailed(e: unknown): void {
    const reason = reasonOf(e);
    console.warn(`board: couldn't send the card: ${reason}`);
    this.#set({ card: "failed", cardError: reason });
    this.#cardErrors.set(reason);
    clearTimeout(this.#cardRetry);
    const ms = Math.min(this.#retryMs * 2 ** this.#cardRetries++, CARD_RETRY_MAX_MS);
    this.#cardRetry = setTimeout(() => void this.#sync(), ms);
  }

  #cardStored(patch: Partial<BoardSnapshot> = {}): void {
    this.#cardRetries = 0;
    clearTimeout(this.#cardRetry);
    this.#set({ ...patch, card: "stored", cardError: null });
    this.#cardErrors.set(null);
  }

  /** attachApprovalDisplay's transport for the current connection; it disconnects with the board. */
  approvalTransport(): ApprovalDisplayTransport {
    let failures = 0;
    return {
      write: async (frame: ApprovalConsoleFrame) => {
        if (!this.ready) throw new Error("board not connected");
        try {
          await this.#write(frame);
          failures = 0;
        } catch (e) {
          console.warn("board: an approval-console frame didn't go out", e);
          // One failed frame is replaced by the next second's; several in a row mean the screen is stale.
          if (++failures >= this.#frameFailures) throw e;
        }
      },
      listen: (onCommand, onDisconnect) => {
        const offCommand = this.onCommand(onCommand);
        const offStatus = this.subscribe(() => {
          if (!this.ready) onDisconnect();
        });
        if (!this.ready) queueMicrotask(onDisconnect);
        return () => {
          offCommand();
          offStatus();
        };
      },
    };
  }

  // BOARD_LINK pairing: the person checks the code on the board and holds BOOT; a new secret
  // replaces any older pairing.
  async pair(): Promise<PairResult> {
    if (!this.found || this.#snap.pairing) return "failed";
    const { secret, code } = newPairing();
    let keyId: string;
    let key: CryptoKey;
    try {
      keyId = await keyIdOf(secret);
      key = await hmacKey(secret);
    } catch (e) {
      secret.fill(0);
      console.error("board: couldn't make a pairing key", e);
      return "failed";
    }
    let begunAt = 0;
    /** The board confirmed our key: it no longer holds the old one, whatever happens next. */
    let boardTook = false;
    let finish: (r: PairResult) => void = () => undefined;
    const answer = new Promise<PairResult>((resolve) => {
      const status = this.#snap.status;
      const done = (r: PairResult) => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        offStatus();
        resolve(r);
      };
      finish = done;
      const waiter = (m: BoardMessage) => {
        if (m.type === "pair-cancel") return done("cancelled");
        if (m.type !== "pair-ok") return;
        if (m.pair !== keyId) return done("failed");
        boardTook = true;
        const after = Date.now() - begunAt;
        if (after < this.#minPairMs) {
          // LCD — app-side stopgap until the firmware proves the hold: no person confirms this fast.
          console.warn(`board: refused a pair-ok ${after} ms after pair-begin (under ${this.#minPairMs} ms)`);
          return done("failed");
        }
        done("paired");
      };
      const offStatus = this.subscribe(() => this.#snap.status !== status && done("failed"));
      const timer = setTimeout(() => done("timeout"), this.#pairMs);
      this.#waiters.add(waiter);
    });
    this.#set({ pairing: { code } });
    try {
      try {
        begunAt = Date.now();
        await this.#write({ v: 1, type: "pair-begin", secret: base64(secret), code });
      } catch (e) {
        console.warn("board: couldn't send pair-begin", e);
        finish("failed");
        return "failed";
      } finally {
        secret.fill(0);
      }
      const result = await answer;
      if (result !== "paired") {
        if (boardTook) this.#boardHolds(keyId);
        return result;
      }
      // The board holds our secret now, though its last hello predates it.
      const hello = this.#snap.hello;
      if (hello) this.#set({ hello: { ...hello, pair: keyId } });
      try {
        await this.#store.save({ keyId, key });
      } catch (e) {
        console.error("board: paired, but couldn't save the pairing", e);
        this.#boardHolds(keyId);
        return "save-failed";
      }
      return "paired";
    } finally {
      this.#set({ pairing: null });
    }
  }

  /** The board stores `keyId` but this computer kept its old pairing: unpaired now, and the board's
   * answer to a fresh hello confirms it. */
  #boardHolds(keyId: string): void {
    const hello = this.#snap.hello;
    if (hello) this.#updatePaired({ hello: { ...hello, pair: keyId } });
    this.#writeHello();
  }

  /** Forgets the paired board here and asks the board to forget us, whatever it answers. */
  async forget(): Promise<ForgetResult> {
    let told = true;
    if (this.found)
      await this.#write({ v: 1, type: "pair-reset" }).catch((e) => {
        console.warn("board: couldn't send pair-reset", e);
        told = false;
      });
    try {
      await this.#store.clear();
    } catch (e) {
      console.error("board: couldn't forget the pairing", e);
      return "failed";
    }
    return told ? "forgotten" : "board-unconfirmed";
  }

  async #loadPairing(): Promise<void> {
    let pairingError: string | null = null;
    try {
      this.#pairedBoard = await this.#store.load();
    } catch (e) {
      console.error("board: couldn't read the pairing", e);
      this.#pairedBoard = null;
      pairingError = reasonOf(e);
    }
    this.#updatePaired({ pairingError });
    // Another window just paired: this window's hello predates it, so ask the board again.
    const hello = this.#snap.hello;
    if (this.found && this.#pairedBoard && hello?.pair !== this.#pairedBoard.keyId) this.#writeHello();
  }

  /** Applies `patch` and the paired state it implies in one update, so a hello from the same paired
   * board never flickers through paired:false (that would rebuild the approvals screen). */
  #updatePaired(patch: Partial<BoardSnapshot> = {}): void {
    const newHello = "hello" in patch;
    const hello = newHello ? (patch.hello ?? null) : this.#snap.hello;
    const paired = !!this.#pairedBoard && hello?.pair === this.#pairedBoard.keyId;
    const hasPairing = !!this.#pairedBoard;
    const changed = paired !== this.#snap.paired || hasPairing !== this.#snap.hasPairing;
    const same = Object.entries(patch).every(([k, v]) => this.#snap[k as keyof BoardSnapshot] === v);
    if (!changed && !newHello && same) return;
    this.#set({ ...patch, paired, hasPairing });
    if (!changed && !newHello) return;
    // A hello may be a rebooted board: stop any upload and send it everything again.
    this.#epoch++;
    this.#hintSent = null;
    this.#sessionsSent = null;
    this.#sendHint();
    this.#sendSessions();
    void this.#sync();
  }

  #command(raw: Record<string, unknown>): void {
    const board = this.#pairedBoard;
    // An unpaired board's buttons do nothing.
    if (!this.ready || !board) return;
    const { mac, ...rest } = raw;
    const c = ApprovalConsoleCommand.safeParse(rest);
    if (!c.success) return;
    this.#commandChain = this.#commandChain
      .then(async () => {
        if (c.data.type === "decide") {
          let ok: boolean;
          try {
            ok = await verifyDecideMac(board.key, c.data, mac);
          } catch (e) {
            console.error("board: couldn't check a decide's mac", e);
            return;
          }
          if (!ok) {
            // No desktop security-event sink exists; counted and logged here.
            console.warn("board: dropped a decide with a missing or wrong mac");
            return this.#set({ rejected: this.#snap.rejected + 1 });
          }
        }
        if (this.ready && this.#pairedBoard === board) for (const fn of [...this.#commands]) fn(c.data);
      })
      .catch((e) => console.error("board: a board command failed", e));
  }

  #set(p: Partial<BoardSnapshot>): void {
    this.#snap = { ...this.#snap, ...p };
    for (const l of [...this.#listeners]) l();
  }

  #write(msg: object): Promise<void> {
    return this.#port.write(JSON.stringify(msg));
  }

  #onStatus(s: BoardStatus): void {
    const was = this.#snap.status;
    if (JSON.stringify(was) === JSON.stringify(s)) return;
    this.#epoch++;
    clearTimeout(this.#helloRetry);
    this.#helloRetry = undefined;
    this.#helloRetries = 0;
    this.#set({ status: s, hello: null, paired: false, card: this.#snap.card === "stored" ? "stored" : "none" });
    if (s.state === "connected") this.#writeHello();
  }

  #onLine(line: string): void {
    const m = parseBoardLine(line);
    if (!m) return;
    for (const w of [...this.#waiters]) w(m);
    if (m.type === "hello") {
      const { type: _t, ...hello } = m;
      this.#updatePaired({ hello });
    } else if (m.type === "pair-cleared") {
      // The board forgot us (its 10 s BOOT hold): its answer to a fresh hello says it's unpaired.
      this.#writeHello();
    } else if (m.type === "pet") {
      if (this.ready) for (const fn of [...this.#pets]) fn(m.trick);
    } else if (m.type === "other") this.#command(m.raw);
  }

  #card(source: CardSource): Promise<BoardCard> {
    if (this.#converted?.id !== source.id) {
      const card = source.convert();
      this.#converted = { id: source.id, card };
      // A failed conversion may succeed later (an expired URL refreshed): don't cache it.
      card.catch(() => {
        if (this.#converted?.card === card) this.#converted = null;
      });
    }
    return this.#converted.card;
  }

  async #sync(): Promise<void> {
    const source = this.#source;
    const hello = this.#snap.hello;
    if (!source || !hello || !this.ready) return;
    // One upload at a time; a board that restarted under it stops answering and the attempt retries.
    if (this.#uploading) return void (this.#again = true);
    const epoch = ++this.#epoch;
    let card: BoardCard;
    try {
      if (!this.#converted || this.#converted.id !== source.id) this.#set({ card: "converting" });
      card = await this.#card(source);
    } catch (e) {
      if (epoch === this.#epoch) this.#cardFailed(e);
      return;
    }
    if (epoch !== this.#epoch) return;
    if (hello.card === card.key) return this.#cardStored();
    this.#uploading = true;
    this.#set({ card: "uploading" });
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.#upload(card, epoch);
          this.#cardStored({ hello: this.#snap.hello && { ...this.#snap.hello, card: card.key } });
          return;
        } catch (e) {
          if (e instanceof Aborted || epoch !== this.#epoch) return;
          if (attempt >= this.#attempts) return this.#cardFailed(e);
        }
      }
    } finally {
      this.#uploading = false;
      if (this.#again) {
        this.#again = false;
        void this.#sync();
      }
    }
  }

  /** Waits for the board's reply `pick` accepts; a failed card-ack for this key fails the attempt. */
  #reply(key: string, epoch: number, pick: (m: BoardMessage) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        clearInterval(watch);
        this.#waiters.delete(waiter);
        if (err) reject(err);
        else resolve();
      };
      const waiter = (m: BoardMessage) => {
        if (m.type === "card-ack" && m.key === key && !m.ok) done(new Error(`card-ack ${m.reason ?? "failed"}`));
        else if (pick(m)) done();
      };
      const timer = setTimeout(() => done(new Error("board did not answer")), this.#replyMs);
      const watch = setInterval(() => epoch !== this.#epoch && done(new Aborted()), 50);
      this.#waiters.add(waiter);
    });
  }

  async #upload(card: BoardCard, epoch: number): Promise<void> {
    const { key } = card;
    const guard = () => {
      if (epoch !== this.#epoch || !this.ready) throw new Aborted();
    };
    guard();
    await this.#write({
      v: 1,
      type: "card-begin",
      key,
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      frames: CARD_FRAMES,
    });
    for (const frame of CARD_FRAMES) {
      const bytes = card.frames[frame];
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        guard();
        const data = bytes.subarray(offset, offset + CHUNK_BYTES);
        // Armed before the write so a fast reply isn't missed.
        const accepted = this.#reply(
          key,
          epoch,
          // BOARD_LINK leaves open whether `offset` is the chunk's start or the next one's: take either.
          (m) =>
            m.type === "card-progress" &&
            m.key === key &&
            m.frame === frame &&
            (m.offset === offset || m.offset === offset + data.length),
        );
        await this.#write({ v: 1, type: "card-chunk", frame, offset, data: base64(data) }).catch((e) => {
          accepted.catch(() => undefined);
          throw e;
        });
        await accepted;
      }
    }
    guard();
    const acked = this.#reply(key, epoch, (m) => m.type === "card-ack" && m.key === key && m.ok);
    await this.#write({ v: 1, type: "card-end", key }).catch((e) => {
      acked.catch(() => undefined);
      throw e;
    });
    await acked;
  }
}
