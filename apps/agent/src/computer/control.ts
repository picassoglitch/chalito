import { randomBytes } from "node:crypto";
import { isSignedOrigin, type Origin, type ResolutionReason } from "@chalito/protocol";
import type { Policy } from "../policy/schema.js";
import { downscaleRgba, encodePngRgb, fitSize } from "./image.js";
import { ComputerUnsupportedError, type DisplayInfo, type NativeDriver } from "./native.js";
import { COMPUTER_SERVER, APP_TOOLS, ToolArgs, UNCOUNTED, isToolName, parseCombo, type ToolName } from "./tools.js";
import type { LaunchableApp } from "../drivers/apps.js";
import type { AppLaunchResult } from "../drivers/app-launch.js";
import { originOf } from "../drivers/web-app.js";

/**
 * Computer control on this device (owner design, 2026-10-05): who may act, when, and how fast.
 *
 * - Off unless the person turned it on locally (`policy.computer.enabled`, written only by the
 *   OS-authenticated enable path in toggle.ts). Turning it off ends control at once.
 * - A session gets the local MCP server (`attach`) only while it's on and only for a signed
 *   origin (this computer or a trusted device). Its tools do nothing until the session holds a
 *   grant: the first call asks the person for a `computer_control` approval (HIGH, passkey
 *   step-up) on a trusted device. One grant per session; a deny sticks for that session.
 * - Every action needs the desktop app showing its always-on-top indicator (the app's poll is the
 *   heartbeat), passes a per-session rate limit, and is audited without its contents (no screen
 *   pixels, no typed text, no window titles).
 * - `kill` (hotkey, tray, panel, CLI, policy) revokes every grant, releases a held mouse button
 *   and interrupts the sessions that had control.
 */

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ComputerApprovalOutcome {
  allow: boolean;
  reason: ResolutionReason;
  byDeviceId?: string;
}

export interface ComputerDeps {
  policy: () => Policy["computer"];
  /** A `computer_control` approval for this session, announced to the person's devices like any other. */
  requestApproval: (
    sid: string,
    input: {
      origin: Origin;
      /** `computer_control` (default) for the session's grant; `app_control` for one app (launch_app / open_web_app). */
      kind?: "computer_control" | "app_control";
      details: { toolName: string; input: unknown; reasons: string[] };
    },
  ) => Promise<ComputerApprovalOutcome>;
  interrupt: (sid: string) => Promise<void>;
  /** The native layer, loaded on first use; throws ComputerUnsupportedError where it can't run. */
  driver: () => NativeDriver;
  audit: (type: string, meta: Record<string, unknown>) => void;
  /** Reports the state to the account (`computer.changed` DeviceEvent). */
  publish: (state: { enabled: boolean; activeSessions: number; by?: string }) => void;
  /** How to start the MCP server, or null while the broker socket isn't up (no desktop app). */
  mcpLaunch: () => { command: string; args: string[]; socket: string } | null;
  now: () => number;
  /** Language of the approval's reasons (the person reads them on their phone). */
  locale?: () => "es" | "en";
  sleep?: (ms: number) => Promise<void>;
  newToken?: () => string;
  /** How long an action waits for the desktop app to show the indicator (default 3 s). */
  indicatorWaitMs?: number;
  /** The desktop app polls every 500 ms; a heartbeat older than this means it's gone (default 2 s). */
  heartbeatTtlMs?: number;
  /**
   * The person's launchable apps (drivers/apps.ts AppLauncher): `list_apps`, `launch_app` and
   * `open_web_app`. Absent = those tools answer that no apps are set up.
   */
  apps?: {
    list(): LaunchableApp[];
    has(appId: string, kind?: LaunchableApp["kind"]): boolean;
    launch(appId: string, opts?: { kind?: LaunchableApp["kind"]; url?: string }): Promise<AppLaunchResult>;
  };
}

export type SessionControl = "idle" | "pending" | "granted" | "denied" | "revoked";

interface Ctl {
  sid: string;
  token: string;
  label: string;
  adapter: string;
  origin: Origin;
  state: SessionControl;
  since: number | null;
  pending: Promise<boolean> | null;
  bucket: { tokens: number; at: number };
  /** Size of the last screenshot per display: model coordinates are in its pixels. */
  shot: Map<number, { width: number; height: number }>;
  buttonDown: boolean;
  rateAudited: number;
  /** Apps this session may launch and drive (each one approved as `app_control`). */
  apps: Set<string>;
  appsDenied: Set<string>;
  appPending: Map<string, Promise<boolean>>;
}

export interface ComputerStatus {
  enabled: boolean;
  /** Sessions holding control: the desktop shows the indicator while this isn't empty. */
  active: { sid: string; label: string; since: number }[];
  /** Sessions waiting for the person's approval. */
  pending: { sid: string; label: string }[];
}

export interface ToolOutput {
  text: string;
  image?: { data: string; mimeType: "image/png" };
}

/** A refusal or failure the model sees as a tool error (`message`); `code` goes to the audit. */
export class ComputerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}

const TYPE_CHUNK = 16;

/** What the approval says, on the person's trusted device. */
const REASONS = {
  es: [
    "La sesión pide ver tu pantalla y usar el mouse y el teclado de esta computadora hasta que termine.",
    "Se detiene con Ctrl+Alt+Esc o con «Detener control» en el ícono de Chalito.",
  ],
  en: [
    "This session asks to see your screen and use this computer's mouse and keyboard until it ends.",
    "Stop it with Ctrl+Alt+Esc or “Stop control” in Chalito's tray icon.",
  ],
} as const;

const MESSAGES = {
  disabled: "Computer control is off on this computer. The person can turn it on there (`chalito computer enable`).",
  unknown_session: "This session has no computer control.",
  denied: "The person denied computer control for this session.",
  revoked: "Computer control was stopped for this session.",
  unsigned_origin: "Computer control isn't available for prompts from connected apps or calls.",
  no_desktop: "Computer control needs the Chalito desktop app open on this computer.",
  indicator: "The Chalito desktop app isn't showing its control indicator, so nothing was done.",
  rate_limited: "Too many actions in the last minute; wait a moment and try again.",
  bad_args: "Invalid arguments.",
  no_window: "No window with that id; call list_windows again.",
  unknown_app: "No app with that id on this computer; call list_apps.",
  app_denied: "The person denied controlling that app in this session.",
  origin_not_allowed: "That page isn't on the app's own site.",
  launch_failed: "The app couldn't be opened on this computer.",
} as const;

/** What the `app_control` approval says. */
const APP_REASONS = {
  es: (name: string) => [
    `La sesión pide abrir ${name} y usarlo con el mouse y el teclado de esta computadora hasta que termine.`,
    "Incluye ver tu pantalla. Se detiene con Ctrl+Alt+Esc o con «Detener control» en el ícono de Chalito.",
  ],
  en: (name: string) => [
    `This session asks to open ${name} and use it with this computer's mouse and keyboard until it ends.`,
    "That includes seeing your screen. Stop it with Ctrl+Alt+Esc or “Stop control” in Chalito's tray icon.",
  ],
} as const;

export class ComputerControl {
  readonly #byToken = new Map<string, Ctl>();
  readonly #bySid = new Map<string, Ctl>();
  #beat: { at: number; indicatorShown: boolean } | null = null;
  #driver: NativeDriver | null = null;
  /** Starts as "off, nobody": an agent that never had it on reports nothing. */
  #lastPublished = JSON.stringify([false, 0]);

  constructor(private readonly d: ComputerDeps) {}

  enabled(): boolean {
    return this.d.policy()?.enabled === true;
  }

  get #sleep() {
    return this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /**
   * The MCP server for a new session, or null when computer control is off, the session came
   * from an unsigned origin, or the desktop app (and with it the broker) isn't running.
   */
  attach(sid: string, s: { label: string; adapter: string; origin: Origin }): McpServerSpec | null {
    if (!this.enabled() || !isSignedOrigin(s.origin)) return null;
    const launch = this.d.mcpLaunch();
    if (!launch) return null;
    const token = this.d.newToken?.() ?? randomBytes(32).toString("hex");
    const ctl: Ctl = {
      sid,
      token,
      label: s.label,
      adapter: s.adapter,
      origin: s.origin,
      state: "idle",
      since: null,
      pending: null,
      bucket: { tokens: this.#rate(), at: this.d.now() },
      shot: new Map(),
      buttonDown: false,
      rateAudited: 0,
      apps: new Set(),
      appsDenied: new Set(),
      appPending: new Map(),
    };
    this.#byToken.set(token, ctl);
    this.#bySid.set(sid, ctl);
    return {
      name: COMPUTER_SERVER,
      command: launch.command,
      args: launch.args,
      env: { CHALITO_COMPUTER_SOCKET: launch.socket, CHALITO_COMPUTER_TOKEN: token },
    };
  }

  /**
   * The agent's tool gate for this server's tools (Claude Code's PreToolUse). It lets a call
   * through to the broker, where the grant, indicator and rate checks happen; it refuses at once
   * when control is off, ended, denied, or the turn comes from an unsigned origin.
   */
  gate(sid: string, origin: Origin): { allow: true } | { allow: false; reason: string } {
    const ctl = this.#bySid.get(sid);
    if (!this.enabled()) return { allow: false, reason: "computer_disabled" };
    if (!ctl) return { allow: false, reason: "computer_not_attached" };
    if (!isSignedOrigin(origin)) return { allow: false, reason: "computer_unsigned_origin" };
    if (ctl.state === "denied" || ctl.state === "revoked") return { allow: false, reason: `computer_${ctl.state}` };
    return { allow: true };
  }

  /** The desktop app polled recently (it shows the indicator and holds the kill switch). */
  desktopPresent(): boolean {
    return !!this.#beat && this.d.now() - this.#beat.at <= (this.d.heartbeatTtlMs ?? 2000);
  }

  /** …and the indicator is on screen now (remote screen streams only while this holds). */
  indicatorShown(): boolean {
    return this.desktopPresent() && this.#beat!.indicatorShown;
  }

  /** The desktop app's poll: it shows the indicator while `active` isn't empty and says whether it is shown. */
  heartbeat(indicatorShown: boolean): ComputerStatus {
    this.#beat = { at: this.d.now(), indicatorShown };
    return this.status();
  }

  status(): ComputerStatus {
    const all = [...this.#bySid.values()];
    return {
      enabled: this.enabled(),
      active: all
        .filter((c) => c.state === "granted")
        .map((c) => ({ sid: c.sid, label: c.label, since: c.since ?? 0 })),
      pending: all
        .filter((c) => c.state === "pending" || (c.state === "idle" && c.appPending.size > 0))
        .map((c) => ({ sid: c.sid, label: c.label })),
    };
  }

  /** Stops every session's control now. Returns how many sessions lost it. */
  async kill(by: string): Promise<number> {
    // Includes sessions waiting on an app_control approval: its answer must grant nothing.
    const affected = [...this.#bySid.values()].filter(
      (c) => c.state === "granted" || c.state === "pending" || c.appPending.size > 0,
    );
    for (const c of affected) c.state = "revoked";
    if (affected.some((c) => c.buttonDown) && this.#driver) {
      for (const c of affected) c.buttonDown = false;
      try {
        this.#driver.button(false, "left");
      } catch {
        /* best effort */
      }
    }
    this.d.audit("computer.killed", { by, sessions: affected.length });
    this.#publish(by, true);
    await Promise.all(affected.map((c) => this.d.interrupt(c.sid).catch(() => undefined)));
    return affected.length;
  }

  /** The session ended: its token stops working. */
  end(sid: string): void {
    const ctl = this.#bySid.get(sid);
    if (!ctl) return;
    const had = ctl.state === "granted";
    ctl.state = "revoked";
    this.#bySid.delete(sid);
    this.#byToken.delete(ctl.token);
    if (had) this.#publish("session_end");
  }

  /** After any policy change: turned off ends every grant; the state is reported either way. */
  async onPolicyChange(): Promise<void> {
    if (!this.enabled()) {
      const active = [...this.#bySid.values()].some(
        (c) => c.state === "granted" || c.state === "pending" || c.appPending.size > 0,
      );
      if (active) {
        await this.kill("policy");
        return;
      }
    }
    this.#publish();
  }

  /** One tool call from the MCP server (broker.ts). Throws ComputerError with what the model should read. */
  async call(token: string, tool: string, rawArgs: unknown): Promise<ToolOutput> {
    const ctl = typeof token === "string" ? this.#byToken.get(token) : undefined;
    if (!ctl) throw new ComputerError("unknown_session", MESSAGES.unknown_session);
    const name: ToolName | null = isToolName(tool) ? tool : null;
    try {
      if (!name) throw new ComputerError("bad_tool", `Unknown tool ${JSON.stringify(String(tool).slice(0, 40))}.`);
      const parsed = ToolArgs[name].safeParse(rawArgs ?? {});
      if (!parsed.success)
        throw new ComputerError("bad_args", `${MESSAGES.bad_args} ${parsed.error.issues[0]?.message ?? ""}`.trim());
      const args = parsed.data as Record<string, unknown>;
      this.#checkLive(ctl);
      if (APP_TOOLS.has(name)) {
        // One app at a time, each approved (`app_control`), which also grants this session control.
        const appId = args.appId as string;
        if (!this.d.apps?.has(appId, name === "open_web_app" ? "web-app" : undefined))
          throw new ComputerError("unknown_app", MESSAGES.unknown_app);
        if (!ctl.apps.has(appId)) {
          if (!this.desktopPresent()) throw new ComputerError("no_desktop", MESSAGES.no_desktop);
          if (!(await this.#grantApp(ctl, appId, name))) {
            this.#checkLive(ctl);
            throw new ComputerError("app_denied", MESSAGES.app_denied);
          }
        }
      } else if (ctl.state !== "granted" && name !== "list_apps") {
        if (!this.desktopPresent()) throw new ComputerError("no_desktop", MESSAGES.no_desktop);
        if (!(await this.#grant(ctl, name))) this.#checkLive(ctl, "denied");
      }
      if (!UNCOUNTED.has(name)) this.#take(ctl);
      await this.#indicator();
      this.#checkLive(ctl);
      const out = await this.#run(ctl, name, args);
      this.#audit(ctl, name, args, true);
      return out;
    } catch (err) {
      const e =
        err instanceof ComputerError
          ? err
          : err instanceof ComputerUnsupportedError
            ? new ComputerError(err.code, err.message)
            : new ComputerError("native_failed", "The action failed on this computer.");
      if (e.code !== "rate_limited" || this.d.now() - ctl.rateAudited > 60_000) {
        if (e.code === "rate_limited") ctl.rateAudited = this.d.now();
        this.#audit(ctl, name ?? "unknown", {}, false, e.code);
      }
      throw e;
    }
  }

  // ---- internals -------------------------------------------------------------------

  #rate(): number {
    return this.d.policy()?.maxActionsPerMinute ?? 60;
  }

  #checkLive(ctl: Ctl, fallback?: "denied"): void {
    if (!this.enabled()) throw new ComputerError("disabled", MESSAGES.disabled);
    if (!isSignedOrigin(ctl.origin)) throw new ComputerError("unsigned_origin", MESSAGES.unsigned_origin);
    if (ctl.state === "revoked") throw new ComputerError("revoked", MESSAGES.revoked);
    if (ctl.state === "denied" || fallback === "denied") throw new ComputerError("denied", MESSAGES.denied);
  }

  async #indicator(): Promise<void> {
    const deadline = this.d.now() + (this.d.indicatorWaitMs ?? 3000);
    for (;;) {
      if (this.indicatorShown()) return;
      if (this.d.now() >= deadline) throw new ComputerError("indicator", MESSAGES.indicator);
      await this.#sleep(100);
    }
  }

  #take(ctl: Ctl): void {
    const cap = this.#rate();
    const now = this.d.now();
    const b = ctl.bucket;
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) * cap) / 60_000);
    b.at = now;
    if (b.tokens < 1) throw new ComputerError("rate_limited", MESSAGES.rate_limited);
    b.tokens -= 1;
  }

  #grant(ctl: Ctl, first: ToolName): Promise<boolean> {
    if (ctl.state === "granted") return Promise.resolve(true);
    if (ctl.state !== "idle" && ctl.state !== "pending") return Promise.resolve(false);
    ctl.pending ??= (async () => {
      ctl.state = "pending";
      this.d.audit("computer.requested", { sid: ctl.sid, adapter: ctl.adapter, firstTool: first });
      this.#publish();
      let outcome: ComputerApprovalOutcome;
      try {
        outcome = await this.d.requestApproval(ctl.sid, {
          origin: ctl.origin,
          details: {
            toolName: "computer_control",
            input: { session: ctl.label, adapter: ctl.adapter, firstAction: first },
            reasons: [...REASONS[this.d.locale?.() ?? "es"]],
          },
        });
      } catch {
        outcome = { allow: false, reason: "timeout_deny" };
      }
      // An app_control approval granted control meanwhile.
      if ((ctl.state as SessionControl) === "granted" && this.enabled()) return true;
      // Killed, ended or turned off while the person was deciding: the answer no longer applies.
      if (ctl.state !== "pending" || !this.enabled()) {
        if (ctl.state === "pending") ctl.state = "revoked";
        return false;
      }
      ctl.state = outcome.allow ? "granted" : "denied";
      ctl.since = outcome.allow ? this.d.now() : null;
      this.d.audit(outcome.allow ? "computer.granted" : "computer.denied", {
        sid: ctl.sid,
        reason: outcome.reason,
        ...(outcome.byDeviceId ? { by: outcome.byDeviceId } : {}),
      });
      this.#publish();
      return outcome.allow;
    })().finally(() => {
      ctl.pending = null;
    });
    return ctl.pending;
  }

  /** An `app_control` approval for one app in this session (HIGH, passkey step-up). */
  #grantApp(ctl: Ctl, appId: string, first: ToolName): Promise<boolean> {
    if (ctl.apps.has(appId)) return Promise.resolve(true);
    if (ctl.appsDenied.has(appId) || ctl.state === "denied" || ctl.state === "revoked") return Promise.resolve(false);
    const existing = ctl.appPending.get(appId);
    if (existing) return existing;
    const name = this.d.apps?.list().find((a) => a.id === appId)?.name ?? appId;
    const p = (async () => {
      this.d.audit("computer.app_requested", { sid: ctl.sid, adapter: ctl.adapter, appId, firstTool: first });
      let outcome: ComputerApprovalOutcome;
      try {
        outcome = await this.d.requestApproval(ctl.sid, {
          origin: ctl.origin,
          kind: "app_control",
          details: {
            toolName: "app_control",
            input: { session: ctl.label, adapter: ctl.adapter, app: appId, appName: name, firstAction: first },
            reasons: [...APP_REASONS[this.d.locale?.() ?? "es"](name)],
          },
        });
      } catch {
        outcome = { allow: false, reason: "timeout_deny" };
      }
      // Killed, ended or turned off while the person was deciding.
      if (ctl.state === "revoked" || ctl.state === "denied" || !this.enabled()) return false;
      this.d.audit(outcome.allow ? "computer.app_granted" : "computer.app_denied", {
        sid: ctl.sid,
        appId,
        reason: outcome.reason,
        ...(outcome.byDeviceId ? { by: outcome.byDeviceId } : {}),
      });
      if (!outcome.allow) {
        ctl.appsDenied.add(appId);
        return false;
      }
      ctl.apps.add(appId);
      if (ctl.state !== "granted") {
        ctl.state = "granted";
        ctl.since = this.d.now();
        this.#publish();
      }
      return true;
    })().finally(() => ctl.appPending.delete(appId));
    ctl.appPending.set(appId, p);
    return p;
  }

  async #launch(appId: string, opts: { kind?: LaunchableApp["kind"]; url?: string }): Promise<ToolOutput> {
    const r = await this.d.apps!.launch(appId, opts);
    if (r.ok) return { text: "ok" };
    const code = r.reason === "origin_not_allowed" ? "origin_not_allowed" : r.reason;
    throw new ComputerError(
      code,
      r.reason === "origin_not_allowed"
        ? MESSAGES.origin_not_allowed
        : r.reason === "no_browser"
          ? "Opening AI websites needs Chrome, Edge or Chromium installed on this computer."
          : r.reason === "not_installed"
            ? "That app isn't installed on this computer."
            : MESSAGES.launch_failed,
    );
  }

  #native(): NativeDriver {
    this.#driver ??= this.d.driver();
    return this.#driver;
  }

  #display(index: number | undefined): DisplayInfo {
    const all = this.#native().displays();
    const d = all[index ?? 0];
    if (!d) throw new ComputerError("bad_args", `No display ${index}; there are ${all.length}.`);
    return d;
  }

  /** Model coordinates (pixels of the last screenshot of that display) → input coordinates. */
  #toScreen(ctl: Ctl, display: number | undefined, x: number, y: number): { x: number; y: number } {
    const d = this.#display(display);
    const shot = ctl.shot.get(d.index) ?? fitSize(d.width, d.height);
    const sx = d.width / shot.width;
    const sy = d.height / shot.height;
    return {
      x: Math.round(d.x + Math.min(x, shot.width - 1) * sx),
      y: Math.round(d.y + Math.min(y, shot.height - 1) * sy),
    };
  }

  async #run(ctl: Ctl, name: ToolName, a: Record<string, unknown>): Promise<ToolOutput> {
    const n = this.#native();
    const at = () => {
      if (a.x === undefined) return;
      const p = this.#toScreen(ctl, a.display as number | undefined, a.x as number, a.y as number);
      n.move(p.x, p.y);
    };
    switch (name) {
      case "screenshot": {
        const d = this.#display(a.display as number | undefined);
        const cap = await n.capture(d.index);
        const size = fitSize(cap.width, cap.height);
        const png = encodePngRgb(
          downscaleRgba(cap.rgba, cap.width, cap.height, size.width, size.height),
          size.width,
          size.height,
        );
        ctl.shot.set(d.index, size);
        const displays = n.displays().map((x) => ({ index: x.index, name: x.name, primary: x.primary }));
        return {
          text: JSON.stringify({ display: d.index, width: size.width, height: size.height, displays }),
          image: { data: png.toString("base64"), mimeType: "image/png" },
        };
      }
      case "mouse_move":
        at();
        return { text: "ok" };
      case "click":
        at();
        n.click(a.button as "left", false);
        return { text: "ok" };
      case "double_click":
        at();
        n.click("left", true);
        return { text: "ok" };
      case "drag": {
        const from = this.#toScreen(ctl, a.display as number | undefined, a.fromX as number, a.fromY as number);
        const to = this.#toScreen(ctl, a.display as number | undefined, a.toX as number, a.toY as number);
        const button = a.button as "left";
        n.move(from.x, from.y);
        n.button(true, button);
        ctl.buttonDown = true;
        try {
          for (let i = 1; i <= 8; i++) {
            await this.#sleep(10);
            this.#checkLive(ctl);
            n.move(Math.round(from.x + ((to.x - from.x) * i) / 8), Math.round(from.y + ((to.y - from.y) * i) / 8));
          }
        } finally {
          if (ctl.buttonDown) n.button(false, button);
          ctl.buttonDown = false;
        }
        return { text: "ok" };
      }
      case "scroll":
        at();
        // robotjs: positive y scrolls up; the tool's positive dy scrolls down.
        n.scroll(a.dx as number, -(a.dy as number));
        return { text: "ok" };
      case "type_text": {
        const chars = [...(a.text as string)];
        for (let i = 0; i < chars.length; i += TYPE_CHUNK) {
          // Between chunks: a kill (or the policy turning off) stops typing mid-text.
          this.#checkLive(ctl);
          n.type(chars.slice(i, i + TYPE_CHUNK).join(""));
          await this.#sleep(0);
        }
        return { text: "ok" };
      }
      case "key": {
        const combo = parseCombo(a.keys as string)!;
        n.key(combo.key, combo.modifiers);
        return { text: "ok" };
      }
      case "list_windows":
        return { text: JSON.stringify(n.windows()) };
      case "focus_window": {
        const win = n.windows().find((w) => w.id === a.id);
        if (!win) throw new ComputerError("no_window", MESSAGES.no_window);
        await n.focus(win);
        return { text: "ok" };
      }
      case "list_apps":
        return { text: JSON.stringify(this.d.apps?.list() ?? []) };
      case "launch_app":
        return this.#launch(a.appId as string, {});
      case "open_web_app":
        return this.#launch(a.appId as string, {
          kind: "web-app",
          ...(typeof a.url === "string" ? { url: a.url } : {}),
        });
      case "wait": {
        let left = a.ms as number;
        while (left > 0) {
          this.#checkLive(ctl);
          const step = Math.min(100, left);
          await this.#sleep(step);
          left -= step;
        }
        return { text: "ok" };
      }
    }
  }

  /** Metadata only: never the typed text, the image, or window titles. */
  #audit(ctl: Ctl, tool: string, a: Record<string, unknown>, ok: boolean, reason?: string): void {
    const meta: Record<string, unknown> = { sid: ctl.sid, tool, ok };
    if (reason) meta.reason = reason;
    for (const k of [
      "display",
      "x",
      "y",
      "fromX",
      "fromY",
      "toX",
      "toY",
      "button",
      "dx",
      "dy",
      "keys",
      "id",
      "ms",
      "appId",
    ])
      if (a[k] !== undefined) meta[k] = a[k];
    // A URL's path and query can carry content: only its origin is kept.
    if (typeof a.url === "string") meta.urlOrigin = originOf(a.url) ?? "invalid";
    if (typeof a.text === "string") meta.textLength = [...a.text].length;
    this.d.audit("computer.action", meta);
  }

  #publish(by?: string, force = false): void {
    const s = this.status();
    const state = { enabled: s.enabled, activeSessions: s.active.length, ...(by ? { by } : {}) };
    const key = JSON.stringify([state.enabled, state.activeSessions]);
    if (!force && key === this.#lastPublished) return;
    this.#lastPublished = key;
    this.d.publish(state);
  }
}
