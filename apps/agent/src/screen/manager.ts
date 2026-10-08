import { randomUUID } from "node:crypto";
import {
  AgentEvent,
  SCREEN_FRAMES_CHANNEL,
  SCREEN_INPUT_CHANNEL,
  SCREEN_INPUT_MAX_BYTES,
  ScreenInput,
  type Origin,
  type ResolutionReason,
  type ScreenEndReason,
  type ScreenMode,
  type ScreenSignal,
  type ScreenSignalBody,
  type ScreenState,
  type SealedEnvelope,
  type SignedScreenSignal,
} from "@chalito/protocol";
import { ComputerUnsupportedError, type DisplayInfo, type MouseButton, type NativeDriver } from "../computer/native.js";
import type { Policy } from "../policy/schema.js";
import { chunkFrame, encodeFrame } from "./frames.js";
import { applyInput, isCounted, releaseAll } from "./input.js";
import type { IceServer, PeerFactory, ScreenChannel, ScreenPeer } from "./peer.js";
import { screenLevel } from "./toggle.js";

/**
 * Remote screen sessions on this device (engine contract §2 SCREEN, ADR 0021).
 *
 * - Off unless the person turned it on here (`policy.screen`, written only by the OS-authenticated
 *   enable path in toggle.ts). `view` lets a trusted browser watch; `control` also lets it send
 *   mouse and keyboard input. Turning either off ends the sessions it allowed, at once.
 * - `open` (the `screen.open` command, signed by a trusted client) asks the person for a
 *   `remote_view` / `remote_control` approval (HIGH, passkey step-up) on a trusted device. Nothing
 *   is captured before the approval; a deny ends the session.
 * - After the approval the agent creates the WebRTC peer and both data channels itself and sends
 *   an agent-signed offer, sealed to the requesting client only. Frames and input then travel over
 *   DTLS between that browser and this device; the cloud only relayed the signaling.
 * - Every frame and every input needs the desktop app showing its always-on-top indicator (the
 *   same heartbeat as computer control); input is rate limited; the kill switch (Ctrl+Alt+Esc,
 *   tray "Detener control", indicator button, panel, CLI) ends every session and lets go of any
 *   held mouse button. Audited with metadata only (counts, never pixels, keys or text).
 */

export interface ScreenApprovalOutcome {
  allow: boolean;
  reason: ResolutionReason;
  byDeviceId?: string;
}

export interface ScreenDeps {
  policy: () => Policy["screen"];
  /** Screen capture and input (computer/native.ts); throws ComputerUnsupportedError where it can't run. */
  driver: () => NativeDriver;
  /** The desktop app's heartbeat is fresh (it shows the indicator and holds the kill switch). */
  desktopPresent: () => boolean;
  /** …and it says the indicator is on screen right now. */
  indicatorShown: () => boolean;
  /** A per-session approval announced to the person's trusted devices (HIGH, passkey step-up). */
  requestApproval: (
    sid: string,
    input: {
      kind: "remote_view" | "remote_control";
      origin: Origin;
      details: { toolName: string; input: unknown; reasons: string[] };
      onRequested: (aid: string, expiresAt: number) => void;
    },
  ) => Promise<ScreenApprovalOutcome>;
  writeEvent: (e: AgentEvent) => Promise<void>;
  upsertSession: (sid: string, doc: Record<string, unknown>) => Promise<void>;
  /** Seals to this agent and that one client (null when the client isn't trusted any more). */
  sealFor: (clientDeviceId: string, value: unknown, aad: string) => Promise<SealedEnvelope | null>;
  signSignal: (body: ScreenSignalBody) => Promise<SignedScreenSignal>;
  peer: PeerFactory;
  iceServers: () => IceServer[];
  /** Recipe apps (drivers/registry.ts): `screen.open {appId}` focuses or launches one first. */
  apps?: {
    has(appId: string): boolean;
    focusOrLaunch(appId: string): Promise<{ ok: boolean; reason?: string }>;
  };
  audit: (type: string, meta: Record<string, unknown>) => void;
  /** Reports the state to the account (`screen.changed` DeviceEvent). */
  publish: (state: { view: boolean; control: boolean; activeSessions: number; by?: string }) => void;
  deviceId: string;
  now: () => number;
  locale?: () => "es" | "en";
  every?: (fn: () => void, ms: number) => { clear(): void };
  after?: (fn: () => void, ms: number) => { clear(): void };
  newSid?: () => string;
}

/** Live (or connecting) screen sessions at once. */
export const SCREEN_MAX_SESSIONS = 2;
/** `screen.open` per 10 minutes: an approval prompt can't be spammed. */
export const SCREEN_OPEN_LIMIT = 6;
export const SCREEN_OPEN_WINDOW_MS = 10 * 60 * 1000;
/** From approval to a live data channel. */
export const SCREEN_CONNECT_TIMEOUT_MS = 60_000;
/** The indicator may be missing this long (an app restart) before the session ends. */
export const SCREEN_INDICATOR_GRACE_MS = 3000;
/** Frames wait while the channel holds more than this (slow link: drop frames, never queue them). */
export const SCREEN_MAX_BUFFERED = 1024 * 1024;
/** Pointer moves are coalesced to at most one per this many ms. */
export const SCREEN_MOVE_MIN_MS = 15;
/** Consecutive failed captures before the session ends. */
const CAPTURE_FAILURES = 5;

export type ScreenOpenResult = { ok: true; sid: string } | { ok: false; reason: string };

interface Sess {
  sid: string;
  mode: ScreenMode;
  origin: Origin;
  clientDeviceId: string;
  label: string;
  appId?: string;
  displayIndex: number;
  state: ScreenState;
  createdAt: number;
  since: number | null;
  seq: number;
  sigSeq: number;
  peer: ScreenPeer | null;
  frames: ScreenChannel | null;
  input: ScreenChannel | null;
  answered: boolean;
  timers: { clear(): void }[];
  loop: { clear(): void } | null;
  busy: boolean;
  frameId: number;
  sent: number;
  captureFailures: number;
  indicatorMissSince: number | null;
  display: DisplayInfo | null;
  displayAt: number;
  held: Set<MouseButton>;
  bucket: { tokens: number; at: number };
  lastMove: number;
  inputs: Record<string, number>;
  dropped: number;
  rateAudited: number;
  chain: Promise<void>;
}

const LABELS = {
  es: { view: "Pantalla remota (ver)", control: "Pantalla remota (control)" },
  en: { view: "Remote screen (view)", control: "Remote screen (control)" },
} as const;

const REASONS = {
  es: {
    view: [
      "Tu navegador de confianza pide ver esta pantalla en vivo hasta que cierres la sesión.",
      "La imagen va directo y cifrada entre ese navegador y esta computadora.",
      "Se detiene con Ctrl+Alt+Esc o con «Detener control» en el ícono de Chalito.",
    ],
    control: [
      "Tu navegador de confianza pide ver esta pantalla y usar su mouse y teclado hasta que cierres la sesión.",
      "La imagen y el teclado van directo y cifrados entre ese navegador y esta computadora.",
      "Se detiene con Ctrl+Alt+Esc o con «Detener control» en el ícono de Chalito.",
    ],
  },
  en: {
    view: [
      "Your trusted browser asks to watch this screen live until you close the session.",
      "The picture goes straight between that browser and this computer, encrypted.",
      "Stop it with Ctrl+Alt+Esc or “Stop control” in Chalito's tray icon.",
    ],
    control: [
      "Your trusted browser asks to see this screen and use its mouse and keyboard until you close the session.",
      "The picture and keystrokes go straight between that browser and this computer, encrypted.",
      "Stop it with Ctrl+Alt+Esc or “Stop control” in Chalito's tray icon.",
    ],
  },
} as const;

const defaultEvery = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return { clear: () => clearInterval(t) };
};
const defaultAfter = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
};

export interface ScreenStatus {
  view: boolean;
  control: boolean;
  /** Sessions approved (connecting or live): the desktop shows the indicator while this isn't empty. */
  active: { sid: string; label: string; mode: ScreenMode; since: number }[];
  pending: { sid: string; label: string; mode: ScreenMode }[];
}

export class ScreenManager {
  readonly #sessions = new Map<string, Sess>();
  #opens: number[] = [];
  #driver: NativeDriver | null = null;
  #lastPublished = JSON.stringify([false, false, 0]);

  constructor(private readonly d: ScreenDeps) {}

  #locale() {
    return this.d.locale?.() ?? "es";
  }

  #native(): NativeDriver {
    this.#driver ??= this.d.driver();
    return this.#driver;
  }

  status(): ScreenStatus {
    const level = screenLevel(this.d.policy());
    const all = [...this.#sessions.values()];
    return {
      view: level !== "off",
      control: level === "control",
      active: all
        .filter((s) => s.state === "connecting" || s.state === "live")
        .map((s) => ({ sid: s.sid, label: s.label, mode: s.mode, since: s.since ?? 0 })),
      pending: all
        .filter((s) => s.state === "waiting_approval")
        .map((s) => ({ sid: s.sid, label: s.label, mode: s.mode })),
    };
  }

  /** `screen.open` from a trusted client. Returns at once; the approval and connection follow. */
  async open(input: { origin: Origin; mode: ScreenMode; display?: string; appId?: string }): Promise<ScreenOpenResult> {
    const level = screenLevel(this.d.policy());
    if (level === "off" || (input.mode === "control" && level !== "control"))
      return { ok: false, reason: "screen_disabled" };
    // A person's browser, signed: never a relayed (mcp:/call:) origin, never this device itself.
    if (!input.origin.startsWith("client:")) return { ok: false, reason: "screen_needs_client" };
    if (!this.d.desktopPresent()) return { ok: false, reason: "no_desktop" };
    if (input.appId && !this.d.apps?.has(input.appId)) return { ok: false, reason: "unknown_app" };
    const now = this.d.now();
    this.#opens = this.#opens.filter((t) => now - t < SCREEN_OPEN_WINDOW_MS);
    if (this.#opens.length >= SCREEN_OPEN_LIMIT) return { ok: false, reason: "rate_limited" };
    const open = [...this.#sessions.values()].filter((s) => s.state !== "ended");
    if (open.length >= SCREEN_MAX_SESSIONS) return { ok: false, reason: "screen_busy" };
    let displays: DisplayInfo[];
    try {
      displays = this.#native().displays();
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof ComputerUnsupportedError ? "screen_unsupported" : "screen_unavailable",
      };
    }
    const displayIndex = input.display === undefined ? 0 : Number(input.display);
    if (!displays[displayIndex]) return { ok: false, reason: "bad_display" };
    this.#opens.push(now);

    const sid = this.d.newSid?.() ?? randomUUID();
    const s: Sess = {
      sid,
      mode: input.mode,
      origin: input.origin,
      clientDeviceId: input.origin.slice("client:".length),
      label: LABELS[this.#locale()][input.mode],
      ...(input.appId ? { appId: input.appId } : {}),
      displayIndex,
      state: "waiting_approval",
      createdAt: now,
      since: null,
      seq: 0,
      sigSeq: 0,
      peer: null,
      frames: null,
      input: null,
      answered: false,
      timers: [],
      loop: null,
      busy: false,
      frameId: 0,
      sent: 0,
      captureFailures: 0,
      indicatorMissSince: null,
      display: displays[displayIndex]!,
      displayAt: now,
      held: new Set(),
      bucket: { tokens: this.#inputRate(), at: now },
      lastMove: 0,
      inputs: {},
      dropped: 0,
      rateAudited: 0,
      chain: Promise.resolve(),
    };
    this.#sessions.set(sid, s);
    try {
      await this.d.upsertSession(sid, {
        deviceId: this.d.deviceId,
        kind: "screen",
        mode: s.mode,
        label: s.label,
        ...(s.appId ? { appId: s.appId } : {}),
        state: "waiting_approval",
        updatedAt: now,
      });
    } catch {
      // No session row: don't leave a pending session holding one of the SCREEN_MAX_SESSIONS slots.
      await this.#end(s, "connect_failed");
      return { ok: false, reason: "screen_unavailable" };
    }
    await this.#state(s, "waiting_approval");
    this.d.audit("screen.requested", {
      sid,
      mode: s.mode,
      by: s.origin,
      display: displayIndex,
      ...(s.appId ? { appId: s.appId } : {}),
    });
    this.#publish();
    void this.#approve(s).catch(() => this.#end(s, "connect_failed"));
    return { ok: true, sid };
  }

  /** `screen.signal` from the browser that opened the session (its answer or ICE). */
  async signal(sid: string, origin: Origin, signal: ScreenSignal): Promise<{ ok: boolean; reason?: string }> {
    const s = this.#sessions.get(sid);
    if (!s || s.state === "ended") return { ok: false, reason: "unknown_session" };
    if (origin !== s.origin) return { ok: false, reason: "origin_mismatch" };
    if (signal.kind === "bye") {
      await this.#end(s, "closed", "client");
      return { ok: true };
    }
    if (!s.peer || s.state === "waiting_approval") return { ok: false, reason: "not_ready" };
    try {
      switch (signal.kind) {
        case "answer":
          if (s.answered) return { ok: false, reason: "duplicate_answer" };
          s.answered = true;
          await s.peer.setAnswer(signal.sdp);
          return { ok: true };
        case "ice":
          if (!signal.candidate) return { ok: true };
          await s.peer.addIce(signal);
          return { ok: true };
        case "offer":
          // The agent is always the offerer: a browser offer is refused.
          return { ok: false, reason: "bad_signal" };
      }
    } catch {
      return { ok: false, reason: "bad_signal" };
    }
  }

  /** `screen.close` (only the browser that opened it) or the local panel. */
  async close(sid: string, origin: Origin): Promise<{ ok: boolean; reason?: string }> {
    const s = this.#sessions.get(sid);
    if (!s || s.state === "ended") return { ok: false, reason: "unknown_session" };
    if (origin !== "local" && origin !== s.origin) return { ok: false, reason: "origin_mismatch" };
    await this.#end(s, "closed", origin === "local" ? "local" : "client");
    return { ok: true };
  }

  /** The kill switch: every screen session ends now. Returns how many did. */
  async kill(by: string): Promise<number> {
    const live = [...this.#sessions.values()].filter((s) => s.state !== "ended");
    await Promise.all(live.map((s) => this.#end(s, "killed", by)));
    if (live.length) this.d.audit("screen.killed", { by, sessions: live.length });
    this.#publish(by, true);
    return live.length;
  }

  /** The account or the person revoked that client: its sessions end. */
  async endForClient(clientDeviceId: string): Promise<void> {
    const mine = [...this.#sessions.values()].filter((s) => s.state !== "ended" && s.clientDeviceId === clientDeviceId);
    await Promise.all(mine.map((s) => this.#end(s, "client_revoked", "revoke")));
  }

  /** After any policy change: what was turned off ends the sessions it allowed. */
  async onPolicyChange(): Promise<void> {
    const level = screenLevel(this.d.policy());
    const gone = [...this.#sessions.values()].filter(
      (s) => s.state !== "ended" && (level === "off" || (s.mode === "control" && level !== "control")),
    );
    await Promise.all(gone.map((s) => this.#end(s, "disabled", "policy")));
    this.#publish(gone.length ? "policy" : undefined);
  }

  async stopAll(): Promise<void> {
    const live = [...this.#sessions.values()].filter((s) => s.state !== "ended");
    await Promise.all(live.map((s) => this.#end(s, "agent_stop", "agent")));
  }

  // ---- internals -------------------------------------------------------------------

  #inputRate(): number {
    return this.d.policy()?.maxInputsPerMinute ?? 600;
  }

  #allowed(s: Sess): boolean {
    const level = screenLevel(this.d.policy());
    return level !== "off" && (s.mode === "view" || level === "control");
  }

  #live(s: Sess): boolean {
    return (s.state === "live" || s.state === "connecting") && this.#allowed(s);
  }

  async #approve(s: Sess): Promise<void> {
    const kind = s.mode === "control" ? "remote_control" : "remote_view";
    let outcome: ScreenApprovalOutcome;
    let aid: string | undefined;
    let announced: Promise<void> = Promise.resolve();
    try {
      outcome = await this.d.requestApproval(s.sid, {
        kind,
        origin: s.origin,
        details: {
          toolName: kind,
          input: {
            mode: s.mode,
            display: s.displayIndex,
            ...(s.appId ? { app: s.appId } : {}),
          },
          reasons: [...REASONS[this.#locale()][s.mode]],
        },
        onRequested: (requested, expiresAt) => {
          aid = requested;
          announced = this.#event(s, {
            type: "approval.requested",
            aid: requested,
            risk: "HIGH",
            expiresAt,
            urgency: "high",
          }).catch(() => undefined);
        },
      });
    } catch {
      outcome = { allow: false, reason: "timeout_deny" };
    }
    await announced;
    if (aid)
      await this.#event(s, {
        type: "approval.resolved",
        aid,
        allow: outcome.allow,
        reason: outcome.reason,
        ...(outcome.byDeviceId ? { byDeviceId: outcome.byDeviceId } : {}),
      }).catch(() => undefined);
    // Killed, closed or turned off while the person was deciding: the answer no longer applies.
    if (s.state !== "waiting_approval") return;
    if (!this.#allowed(s)) return this.#end(s, "disabled", "policy");
    if (!outcome.allow) {
      this.d.audit("screen.denied", { sid: s.sid, mode: s.mode, reason: outcome.reason });
      return this.#end(s, "denied");
    }
    s.state = "connecting";
    s.since = this.d.now();
    this.d.audit("screen.granted", {
      sid: s.sid,
      mode: s.mode,
      reason: outcome.reason,
      ...(outcome.byDeviceId ? { by: outcome.byDeviceId } : {}),
    });
    await this.#state(s, "connecting");
    this.#publish();
    await this.#connect(s);
  }

  async #connect(s: Sess): Promise<void> {
    const after = this.d.after ?? defaultAfter;
    s.timers.push(
      after(() => {
        if (s.state === "connecting") void this.#end(s, "connect_failed");
      }, SCREEN_CONNECT_TIMEOUT_MS),
    );
    s.timers.push(after(() => void this.#end(s, "timeout"), (this.d.policy()?.maxSessionMinutes ?? 60) * 60_000));
    try {
      if (s.appId && this.d.apps) {
        const r = await this.d.apps.focusOrLaunch(s.appId).catch(() => ({ ok: false, reason: "launch_failed" }));
        this.d.audit("screen.app_focus", {
          sid: s.sid,
          appId: s.appId,
          ok: r.ok,
          ...(r.reason ? { reason: r.reason } : {}),
        });
      }
      if (s.state !== "connecting") return;
      const peer = await this.d.peer({ iceServers: this.d.iceServers() });
      if (s.state !== "connecting") return peer.close();
      s.peer = peer;
      // The agent opens every channel; the input channel exists only in control mode.
      s.frames = peer.createChannel(SCREEN_FRAMES_CHANNEL, { ordered: false, maxRetransmits: 0 });
      if (s.mode === "control") {
        s.input = peer.createChannel(SCREEN_INPUT_CHANNEL, { ordered: true });
        s.input.onMessage((m) => this.#onInput(s, m));
      }
      peer.onRemoteChannel((ch) => {
        ch.close();
        this.d.audit("screen.channel_refused", { sid: s.sid });
      });
      peer.onState((st) => {
        if (st === "failed" || st === "closed") void this.#end(s, "peer_closed");
      });
      s.frames.onOpen(() => void this.#goLive(s));
      s.frames.onClose(() => void this.#end(s, "peer_closed"));
      const sdp = await peer.createOffer();
      if (s.state !== "connecting") return;
      await this.#sendSignal(s, { kind: "offer", sdp });
    } catch {
      await this.#end(s, "connect_failed");
    }
  }

  async #goLive(s: Sess): Promise<void> {
    if (s.state !== "connecting") return;
    s.state = "live";
    this.d.audit("screen.live", { sid: s.sid, mode: s.mode });
    await this.#state(s, "live");
    await this.d.upsertSession(s.sid, { state: "live", updatedAt: this.d.now() }).catch(() => undefined);
    // Ended (kill switch, close, policy) while those writes were in flight: #end already ran and
    // had no loop to clear, so starting one now would tick for the life of the process.
    if ((s.state as ScreenState) !== "live") return;
    const fps = Math.min(15, Math.max(1, this.d.policy()?.maxFps ?? 5));
    s.loop = (this.d.every ?? defaultEvery)(() => void this.frame(s.sid), Math.round(1000 / fps));
  }

  /** One frame tick (the stream loop; tests call it directly). */
  async frame(sid: string): Promise<boolean> {
    const s = this.#sessions.get(sid);
    if (!s || s.state !== "live" || s.busy || !s.frames) return false;
    if (!this.#allowed(s)) {
      await this.#end(s, "disabled", "policy");
      return false;
    }
    const now = this.d.now();
    if (!this.d.indicatorShown()) {
      s.indicatorMissSince ??= now;
      if (now - s.indicatorMissSince > SCREEN_INDICATOR_GRACE_MS) await this.#end(s, "indicator");
      return false;
    }
    s.indicatorMissSince = null;
    if (s.frames.bufferedAmount() > SCREEN_MAX_BUFFERED) return false;
    s.busy = true;
    try {
      const n = this.#native();
      if (now - s.displayAt > 5000) {
        s.display = n.displays()[s.displayIndex] ?? s.display;
        s.displayAt = now;
      }
      const cap = await n.capture(s.displayIndex);
      // Killed or turned off while capturing: nothing goes out.
      if (s.state !== "live" || !this.#allowed(s)) return false;
      const enc = encodeFrame(cap);
      for (const chunk of chunkFrame(s.frameId, enc.jpeg)) s.frames.send(chunk);
      s.frameId = (s.frameId + 1) >>> 0;
      s.sent++;
      s.captureFailures = 0;
      return true;
    } catch {
      if (++s.captureFailures >= CAPTURE_FAILURES) await this.#end(s, "capture_failed");
      return false;
    } finally {
      s.busy = false;
    }
  }

  #onInput(s: Sess, m: Buffer | string): void {
    s.chain = s.chain
      .then(() => this.input(s.sid, m))
      .then(
        () => undefined,
        () => undefined,
      );
  }

  /** One message from the input channel (tests call it directly). Returns whether it was applied. */
  async input(sid: string, m: Buffer | string): Promise<boolean> {
    const s = this.#sessions.get(sid);
    if (!s) return false;
    const drop = () => {
      s.dropped++;
      return false;
    };
    if (s.mode !== "control" || s.state !== "live" || !this.#allowed(s)) return drop();
    if (typeof m !== "string" || m.length > SCREEN_INPUT_MAX_BYTES) return drop();
    if (!this.d.indicatorShown()) return drop();
    let parsed: ScreenInput;
    try {
      const r = ScreenInput.safeParse(JSON.parse(m));
      if (!r.success) return drop();
      parsed = r.data;
    } catch {
      return drop();
    }
    const now = this.d.now();
    if (!isCounted(parsed)) {
      if (now - s.lastMove < SCREEN_MOVE_MIN_MS) return drop();
      s.lastMove = now;
    } else {
      const cap = this.#inputRate();
      const b = s.bucket;
      b.tokens = Math.min(cap, b.tokens + ((now - b.at) * cap) / 60_000);
      b.at = now;
      if (b.tokens < 1) {
        if (now - s.rateAudited > 60_000) {
          s.rateAudited = now;
          this.d.audit("screen.rate_limited", { sid: s.sid });
        }
        return drop();
      }
      b.tokens -= 1;
    }
    try {
      const n = this.#native();
      const d = s.display ?? n.displays()[s.displayIndex];
      if (!d) return drop();
      await applyInput(n, d, parsed, s.held, () => this.#live(s));
      s.inputs[parsed.t] = (s.inputs[parsed.t] ?? 0) + 1;
      return true;
    } catch {
      return drop();
    }
  }

  async #sendSignal(s: Sess, signal: ScreenSignal): Promise<void> {
    const signed = await this.d.signSignal({
      v: 1,
      sid: s.sid,
      deviceId: this.d.deviceId,
      seq: s.sigSeq++,
      t: this.d.now(),
      signal,
    });
    const ct = await this.d.sealFor(s.clientDeviceId, signed, `screen:${s.sid}`);
    if (!ct) return this.#end(s, "client_revoked");
    await this.#event(s, { type: "screen.signal", ct });
  }

  async #end(s: Sess, reason: ScreenEndReason, by?: string): Promise<void> {
    if (s.state === "ended") return;
    s.state = "ended";
    for (const t of s.timers) t.clear();
    s.loop?.clear();
    releaseAll(this.#driver, s.held);
    s.frames?.close();
    s.input?.close();
    s.peer?.close();
    this.#sessions.delete(s.sid);
    this.d.audit("screen.ended", {
      sid: s.sid,
      mode: s.mode,
      reason,
      ...(by ? { by } : {}),
      durationMs: s.since ? this.d.now() - s.since : 0,
      frames: s.sent,
      inputs: { ...s.inputs },
      dropped: s.dropped,
    });
    await this.#event(s, { type: "screen.state", state: "ended", mode: s.mode, reason }).catch(() => undefined);
    await this.d.upsertSession(s.sid, { state: "ended", updatedAt: this.d.now() }).catch(() => undefined);
    this.#publish(by);
  }

  async #state(s: Sess, state: ScreenState): Promise<void> {
    await this.#event(s, { type: "screen.state", state, mode: s.mode }).catch(() => undefined);
  }

  async #event(s: Sess, partial: Record<string, unknown>): Promise<void> {
    await this.d.writeEvent(
      AgentEvent.parse({
        v: 1,
        eid: randomUUID(),
        sid: s.sid,
        deviceId: this.d.deviceId,
        seq: s.seq++,
        t: this.d.now(),
        urgency: "low",
        ...partial,
      }),
    );
  }

  #publish(by?: string, force = false): void {
    const st = this.status();
    const key = JSON.stringify([st.view, st.control, st.active.length]);
    if (!force && key === this.#lastPublished) return;
    this.#lastPublished = key;
    this.d.publish({ view: st.view, control: st.control, activeSessions: st.active.length, ...(by ? { by } : {}) });
  }
}
