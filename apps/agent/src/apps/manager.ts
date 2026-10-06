import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AppId,
  PROVIDER_APP,
  type AppConnectionDoc,
  type AppErrorCode,
  type AppState,
  type ProviderConnectMethod,
  type Recipe,
  type RecipeInstall,
  type RecipePlatform,
  type RecipePlatformSpec,
} from "@chalito/protocol";
import { z } from "zod";
import { pinClaude, type ClaudePin } from "../claude-pin.js";
import { officialLink, parseVersion, type ProviderProcs } from "../provider-cli.js";
import type { Logger } from "../redact.js";
import { which } from "../runner.js";
import { SECRET_NAMES, type SecretStore } from "../secrets.js";
import type { CatalogEntry } from "./catalog.js";

/** A sign-in waits this long for the person to finish in the browser. */
export const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;
/** One install (`npm install -g`, `brew install`, `winget install`). */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** A remote install request waits this long for the person to confirm it on this computer. */
export const INSTALL_CONFIRM_MS = 10 * 60 * 1000;
const QUICK_MS = 20_000;

/** The four apps that were providers (#30) keep their keychain slots, so existing keys still work. */
const LEGACY_SECRET: Record<string, string> = {
  "claude-code": SECRET_NAMES.anthropicApiKey,
  codex: SECRET_NAMES.openaiApiKey,
  grok: SECRET_NAMES.xaiApiKey,
  gemini: SECRET_NAMES.googleApiKey,
};
/** What a key usually looks like; a mismatch is only logged (like `chalito keys set`). */
const KEY_SHAPE: Record<string, RegExp> = {
  "claude-code": /^sk-ant-/,
  codex: /^sk-/,
  grok: /^xai-/,
  gemini: /^AIza/,
};

/** The keychain slot of an app's BYO API key. */
export const appSecretName = (id: string) => LEGACY_SECRET[id] ?? `byo-app-${id}-api-key`;

export const platformKey = (p: NodeJS.Platform): RecipePlatform | null =>
  p === "darwin" ? "mac" : p === "win32" ? "windows" : p === "linux" ? "linux" : null;

/** Only web apps: they run wherever there's a browser. */
export const isWebOnly = (r: Recipe) => r.kinds.every((k) => k === "web-app");

/** What the agent remembers per app in ~/.chalito/apps.json (0600; never a secret). */
const AppRecord = z.object({
  mode: z.enum(["api_key", "signin"]).nullable().default(null),
  /** A sign-in finished here (the only signal for CLIs without a status command). */
  signedIn: z.boolean().default(false),
});
const RecordFile = z.record(z.string(), AppRecord);
type AppRecord = z.infer<typeof AppRecord>;

export interface AppPins {
  get(appId: string): ClaudePin | undefined;
  /** Writes the pin into the signed config (config.ts). */
  set(appId: string, pin: ClaudePin): Promise<void>;
}

export interface AppManagerDeps {
  /** ~/.chalito */
  dir: string;
  /** The agent's environment (PATH, HOME, …); CLIs get it plus their recipe's Chalito profile. */
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  secrets: SecretStore;
  procs: ProviderProcs;
  /** The catalog (curated + custom) as it is now. */
  entries: () => CatalogEntry[];
  /**
   * Whether this person may use the app's own plan sign-in: the recipe's `planSignin` must be
   * `on` (owner_only fails closed on the device, D-063); for the four former providers the daemon
   * asks providers.yaml `subscriptionLocal` instead, as before (their recipes mirror it).
   */
  signinAllowed: (entry: CatalogEntry) => boolean;
  pins: AppPins;
  /** chalito.connections (AgentStore.upsertConnection). */
  report: (appId: string, doc: AppConnectionDoc) => Promise<void>;
  /** Something that decides what can run changed (key, sign-in, pin, install). */
  onChange: () => void;
  /** A driver's launcher for this app (drivers/registry.ts), if one is registered. */
  launcher?: (appId: string) => (() => Promise<boolean>) | undefined;
  now: () => number;
  log: Logger;
}

export type AppResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "blocked_by_policy"
        | "provider_busy"
        | "provider_failed"
        | "unknown_app"
        | "recipe_disabled"
        | "app_unavailable";
    };

/** What the desktop panel shows per app. */
export interface AppView {
  appId: string;
  recipe: Recipe;
  custom: boolean;
  /** Curated: always. Custom: enabled on this computer, and the file is unchanged since. */
  enabled: boolean;
  doc: AppConnectionDoc;
  /** The recipe and (for the four former providers) providers.yaml allow the app's own sign-in. */
  signinAllowed: boolean;
  /** A remote install waiting for a local yes (until this time). */
  installRequestedUntil: number | null;
  /** Whether this OS has an entry in the recipe (web apps: always). */
  supported: boolean;
  /** The official install for this OS, if any. */
  install: RecipeInstall | null;
}

interface Live {
  busy: "installing" | "signing_in" | null;
  error: AppErrorCode | null;
  installRequestedUntil: number | null;
  /** The last signin asked for was refused by the recipe or providers.yaml. */
  blocked: boolean;
}

const homeOf = (env: Record<string, string | undefined>) => env.HOME ?? env.USERPROFILE ?? homedir();

/** `~/x`, `%LOCALAPPDATA%\x`, … → a real path (null when the variable isn't set). */
export const expandPath = (p: string, env: Record<string, string | undefined>): string | null => {
  if (p.startsWith("~/")) return join(homeOf(env), p.slice(2));
  const m = /^%([A-Z()]+)%\\(.*)$/.exec(p);
  if (!m) return p;
  const name = m[1] === "PROGRAMFILES(X86)" ? "ProgramFiles(x86)" : m[1]!;
  const base = env[name] ?? env[name.toUpperCase()] ?? (name === "USERPROFILE" ? homeOf(env) : undefined);
  return base ? `${base}\\${m[2]}` : null;
};

/**
 * The connect engine's executor (engine contract v2 §3): detect, install, sign in, status and
 * launch, for any app, driven by its recipe. Generalizes #30's ProviderManager: remote commands
 * (app.* and their provider.* aliases) and the desktop panel both land here, and the remote ones
 * carry no extra power (an install still waits for a local yes, a sign-in still happens on this
 * computer, a custom recipe must already be enabled here, and nothing here touches policy).
 */
export class AppManager {
  readonly #live = new Map<string, Live>();
  #npmBin: Promise<string | null> | null = null;

  constructor(private readonly d: AppManagerDeps) {}

  get #platform(): NodeJS.Platform {
    return this.d.platform ?? process.platform;
  }

  // ---- catalog -------------------------------------------------------------------

  entry(appId: string): CatalogEntry | undefined {
    if (!AppId.safeParse(appId).success) return undefined;
    return this.d.entries().find((e) => e.recipe.id === appId);
  }

  #spec(e: CatalogEntry): RecipePlatformSpec | undefined {
    const k = platformKey(this.#platform);
    return k ? e.recipe.platforms[k] : undefined;
  }

  /** The app's main CLI on this OS (detect.commands[0]), or null for apps without one. */
  #bin(e: CatalogEntry): string | null {
    return this.#spec(e)?.detect.commands?.[0] ?? null;
  }

  #liveOf(appId: string): Live {
    let l = this.#live.get(appId);
    if (!l) {
      l = { busy: null, error: null, installRequestedUntil: null, blocked: false };
      this.#live.set(appId, l);
    }
    return l;
  }

  // ---- state ---------------------------------------------------------------------

  get #file() {
    return join(this.d.dir, "apps.json");
  }

  #records(): Record<string, AppRecord> {
    try {
      return RecordFile.parse(JSON.parse(readFileSync(this.#file, "utf8")));
    } catch {
      // Before the engine: ~/.chalito/providers.json, keyed by provider.
      try {
        const old = RecordFile.parse(JSON.parse(readFileSync(join(this.d.dir, "providers.json"), "utf8")));
        return Object.fromEntries(
          Object.entries(old).flatMap(([p, r]) =>
            Object.hasOwn(PROVIDER_APP, p) ? [[PROVIDER_APP[p as keyof typeof PROVIDER_APP], r]] : [],
          ),
        );
      } catch {
        return {};
      }
    }
  }

  #record(appId: string): AppRecord {
    return this.#records()[appId] ?? { mode: null, signedIn: false };
  }

  #save(appId: string, r: AppRecord) {
    const all = { ...this.#records(), [appId]: r };
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  signinAllowed(appId: string): boolean {
    const e = this.entry(appId);
    return !!e && this.d.signinAllowed(e);
  }

  /** The mode the drivers should use: a sign-in only while the recipe and providers.yaml still allow it. */
  activeMode(appId: string): ProviderConnectMethod | null {
    const mode = this.#record(appId).mode;
    return mode === "signin" && !this.signinAllowed(appId) ? null : mode;
  }

  /** The recipe's Chalito profile for the app's CLI ({chalito} → ~/.chalito). */
  profileEnv(appId: string): Record<string, string> {
    const env = this.entry(appId)?.recipe.profile?.env ?? {};
    return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, join(this.d.dir, v.slice("{chalito}/".length))]));
  }

  /** The environment for an app's CLI: the agent's plus its Chalito profile. */
  cliEnv(appId: string): Record<string, string | undefined> {
    return { ...this.d.env, ...this.profileEnv(appId) };
  }

  // ---- detection -----------------------------------------------------------------

  /** npm's global bin directory (where `npm install -g` puts the CLIs), found once. */
  #globalBin(): Promise<string | null> {
    return (this.#npmBin ??= (async () => {
      const npm = which("npm", this.d.env, this.#platform);
      if (!npm) return null;
      const r = await this.d.procs.run(npm, ["prefix", "-g"], { env: this.d.env, timeoutMs: QUICK_MS });
      const prefix = r.code === 0 ? r.stdout.trim().split("\n").pop()?.trim() : "";
      if (!prefix) return null;
      return this.#platform === "win32" ? prefix : join(prefix, "bin");
    })());
  }

  /** A command of the app: its main CLI (pinned, else PATH, else npm's global bin), or another on PATH. */
  async findCli(appId: string, name?: string): Promise<string | null> {
    const e = this.entry(appId);
    if (!e) return null;
    const bin = this.#bin(e);
    const want = name ?? bin;
    if (!want) return null;
    if (want === bin) {
      const pin = this.d.pins.get(appId);
      if (pin && existsSync(pin.path)) return pin.path;
    }
    const onPath = which(want, this.d.env, this.#platform);
    if (onPath) return onPath;
    const global = await this.#globalBin();
    return global ? which(want, { ...this.d.env, PATH: global }, this.#platform) : null;
  }

  /** A desktop app without a CLI: one of its paths exists, or the OS knows its bundle id / AUMID. */
  async #desktopInstalled(e: CatalogEntry): Promise<boolean> {
    const detect = this.#spec(e)?.detect;
    if (!detect) return false;
    for (const p of detect.paths ?? []) {
      const real = expandPath(p, this.d.env);
      if (real && existsSync(real)) return true;
    }
    if (this.#platform === "darwin")
      for (const id of detect.bundleIds ?? []) {
        // The id is validated by the recipe schema ([A-Za-z0-9.-]); no shell is involved anyway.
        const r = await this.d.procs.run("mdfind", [`kMDItemCFBundleIdentifier == '${id}'`], {
          env: this.d.env,
          timeoutMs: QUICK_MS,
        });
        if (r.code === 0 && r.stdout.trim()) return true;
      }
    if (this.#platform === "win32")
      for (const id of detect.appUserModelIds ?? []) {
        const r = await this.d.procs.run(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", `(Get-StartApps | Where-Object AppID -eq '${id}').AppID`],
          { env: this.d.env, timeoutMs: QUICK_MS },
        );
        if (r.code === 0 && r.stdout.trim()) return true;
      }
    return false;
  }

  async #version(appId: string, path: string): Promise<string | null> {
    const r = await this.d.procs.run(path, ["--version"], { env: this.cliEnv(appId), timeoutMs: QUICK_MS });
    return r.code === 0 ? parseVersion(r.stdout) : null;
  }

  /** argv → [resolved binary, args]; null when argv[0] isn't on this computer. */
  async #resolve(appId: string, argv: readonly string[]): Promise<[string, string[]] | null> {
    const path = await this.findCli(appId, argv[0]);
    return path ? [path, argv.slice(1)] : null;
  }

  /** Whether the app's own sign-in is in place (its status command, else our record of one). */
  async #signedIn(e: CatalogEntry): Promise<boolean> {
    const s = e.recipe.signin;
    if (!s.statusCommand) return this.#record(e.recipe.id).signedIn;
    const cmd = await this.#resolve(e.recipe.id, s.statusCommand);
    if (!cmd) return false;
    const r = await this.d.procs.run(cmd[0], cmd[1], { env: this.cliEnv(e.recipe.id), timeoutMs: QUICK_MS });
    if (r.code !== 0) return false;
    if (!s.statusJson) return true;
    try {
      return (JSON.parse(r.stdout) as Record<string, unknown>)[s.statusJson] === true;
    } catch {
      return false;
    }
  }

  /** The app's own sign-in is something the agent can run and observe (CLI or ACP). */
  #observableSignin(e: CatalogEntry) {
    const s = e.recipe.signin;
    return (s.via === "cli" && !s.interactive) || s.via === "acp";
  }

  /** The status doc, as reported to chalito.connections. */
  async status(appId: string): Promise<AppConnectionDoc | null> {
    const e = this.entry(appId);
    if (!e) return null;
    const live = this.#liveOf(appId);
    if (live.installRequestedUntil !== null && live.installRequestedUntil <= this.d.now()) {
      live.installRequestedUntil = null;
      live.error = "install_unconfirmed";
    }
    const rec = this.#record(appId);
    const base = {
      kind: e.recipe.kinds[0]!,
      custom: e.custom,
      ...(e.custom ? { name: e.recipe.name } : {}),
      at: this.d.now(),
    };
    const doc = (
      state: AppState,
      installed: boolean,
      version: string | null,
      error: AppErrorCode | null,
    ): AppConnectionDoc => ({
      mode: rec.mode,
      connected: state === "connected",
      state,
      cli: { installed, version },
      error: state === "connected" ? null : error,
      ...base,
    });

    // A custom recipe that isn't enabled here (or was edited since): nothing of it runs, not even --version.
    if (e.custom && !e.enabled) return doc("error", false, null, "recipe_disabled");
    if (isWebOnly(e.recipe)) return doc("available", true, null, live.error);
    const spec = this.#spec(e);
    if (!spec) return doc("not_installed", false, null, "unsupported_platform");

    const bin = this.#bin(e);
    if (!bin) {
      // A desktop app: the person signs in inside it, which the agent can't observe.
      if (live.busy === "installing") return doc("installing", false, null, null);
      const installed = await this.#desktopInstalled(e);
      return doc(installed ? "available" : "not_installed", installed, null, live.error);
    }

    const path = live.busy === "installing" ? null : await this.findCli(appId);
    const version = path ? await this.#version(appId, path) : null;
    // A desktop app whose shell command isn't on PATH is still installed.
    const installed =
      !!path ||
      (live.busy !== "installing" && e.recipe.kinds.includes("desktop-app") && (await this.#desktopInstalled(e)));
    let state: AppState;
    if (live.busy === "installing") state = "installing";
    else if (!installed) state = "not_installed";
    else if (live.busy === "signing_in") state = "signing_in";
    else if ((rec.mode === "signin" || live.blocked) && !this.d.signinAllowed(e)) state = "blocked_by_policy";
    else if (rec.mode === "api_key" && (await this.#hasKey(appId))) state = "connected";
    else if (rec.mode === "signin" && (await this.#signedIn(e))) state = "connected";
    else if (live.error) state = "error";
    else if (!e.recipe.apiKey && !this.#observableSignin(e)) state = "available";
    else state = "needs_auth";
    return doc(state, installed, version, live.error);
  }

  async #hasKey(appId: string): Promise<boolean> {
    try {
      return (await this.d.secrets.get(appSecretName(appId))) !== null;
    } catch {
      return false;
    }
  }

  /** The app's key, for the drivers (never logged or reported). */
  async apiKey(appId: string): Promise<string | null> {
    try {
      return await this.d.secrets.get(appSecretName(appId));
    } catch {
      return null;
    }
  }

  async view(): Promise<AppView[]> {
    const out: AppView[] = [];
    for (const e of this.d.entries()) {
      const doc = await this.status(e.recipe.id);
      if (!doc) continue;
      out.push({
        appId: e.recipe.id,
        recipe: e.recipe,
        custom: e.custom,
        enabled: e.enabled,
        doc,
        signinAllowed: this.d.signinAllowed(e),
        installRequestedUntil: this.#liveOf(e.recipe.id).installRequestedUntil,
        supported: isWebOnly(e.recipe) || !!this.#spec(e),
        install: this.#spec(e)?.install ?? null,
      });
    }
    return out;
  }

  /** Reports one app (or all) to chalito.connections; a failed write is logged. */
  async report(appId?: string): Promise<void> {
    for (const id of appId ? [appId] : this.d.entries().map((e) => e.recipe.id)) {
      try {
        const doc = await this.status(id);
        if (doc) await this.d.report(id, doc);
      } catch (err) {
        this.d.log.warn("app.report_failed", { appId: id, error: err instanceof Error ? err.message : "error" });
      }
    }
  }

  /** Unknown app, or a custom recipe not enabled here: what every action checks first. */
  #usable(appId: string): { e: CatalogEntry } | { fail: AppResult } {
    const e = this.entry(appId);
    if (!e) return { fail: { ok: false, reason: "unknown_app" } };
    if (e.custom && !e.enabled) return { fail: { ok: false, reason: "recipe_disabled" } };
    return { e };
  }

  // ---- actions -------------------------------------------------------------------

  /**
   * Stores a BYO API key in the OS keychain. The key is never logged or reported; only its
   * shape is checked (a mismatch is logged, like `chalito keys set` warns).
   */
  async connectKey(appId: string, raw: unknown): Promise<AppResult> {
    const u = this.#usable(appId);
    if ("fail" in u) return u.fail;
    if (!u.e.recipe.apiKey) return { ok: false, reason: "app_unavailable" };
    const live = this.#liveOf(appId);
    const key = typeof raw === "string" ? raw.trim() : "";
    // eslint-disable-next-line no-control-regex
    if (!key || key.length > 512 || /[\s\u0000-\u001f]/.test(key)) {
      live.error = "key_invalid";
      await this.report(appId);
      return { ok: false, reason: "provider_failed" };
    }
    if (KEY_SHAPE[appId] && !KEY_SHAPE[appId].test(key)) this.d.log.warn("app.key_shape_unusual", { appId });
    try {
      await this.d.secrets.set(appSecretName(appId), key);
    } catch {
      live.error = "keychain_failed";
      await this.report(appId);
      return { ok: false, reason: "provider_failed" };
    }
    this.#save(appId, { ...this.#record(appId), mode: "api_key" });
    live.error = null;
    live.blocked = false;
    if (this.#bin(u.e)) await this.#autoPin(appId);
    this.d.log.info("app.connected", { appId, mode: "api_key" });
    await this.report(appId);
    this.d.onChange();
    return { ok: true };
  }

  /**
   * Starts the app's own sign-in on this computer, if its recipe (and providers.yaml, for the
   * former providers) allow it for this person. A CLI or ACP sign-in returns once started and
   * reports when the person finishes (or it times out); a desktop or web app just opens, and the
   * person signs in there.
   */
  async signin(appId: string): Promise<AppResult> {
    const u = this.#usable(appId);
    if ("fail" in u) return u.fail;
    const { e } = u;
    const live = this.#liveOf(appId);
    if (!this.d.signinAllowed(e)) {
      live.blocked = true;
      this.d.log.warn("app.signin_blocked", { appId });
      await this.report(appId);
      return { ok: false, reason: "blocked_by_policy" };
    }
    if (live.busy) return { ok: false, reason: "provider_busy" };
    const s = e.recipe.signin;
    if (s.via === "desktop-app" || s.via === "web") {
      live.blocked = false;
      return this.launch(appId);
    }
    // Only inside the app's own terminal UI: never run headless (the person runs it in a terminal).
    if (s.interactive) {
      this.d.log.info("app.signin_interactive", { appId });
      return { ok: false, reason: "app_unavailable" };
    }
    const cmd = await this.#resolve(appId, s.command!);
    if (!cmd) {
      await this.report(appId);
      return { ok: false, reason: "provider_failed" };
    }
    live.busy = "signing_in";
    live.blocked = false;
    live.error = null;
    await this.report(appId);
    this.signingIn = this.#runSignin(e, cmd).finally(() => (this.signingIn = null));
    return { ok: true };
  }

  /** The running sign-in (tests wait on it). */
  signingIn: Promise<void> | null = null;

  async #runSignin(e: CatalogEntry, [path, args]: [string, string[]]): Promise<void> {
    const appId = e.recipe.id;
    const live = this.#liveOf(appId);
    const s = e.recipe.signin;
    const env = this.cliEnv(appId);
    let ok: boolean;
    let timedOut = false;
    try {
      if (s.via === "acp") {
        ok = await this.d.procs.acpAuthenticate(path, args, {
          env,
          timeoutMs: SIGNIN_TIMEOUT_MS,
          methodId: s.acpMethod!,
        });
      } else {
        let opened = false;
        const r = await this.d.procs.run(path, args, {
          env,
          timeoutMs: SIGNIN_TIMEOUT_MS,
          onLine: (line) => {
            if (opened || !s.openLinks || !s.linkHosts?.length) return;
            const url = officialLink(line, s.linkHosts);
            if (!url) return;
            opened = true;
            void this.d.procs.openUrl(url).catch(() => undefined);
          },
        });
        timedOut = r.code === 124;
        ok = r.code === 0 && (s.statusCommand ? await this.#signedIn(e) : true);
      }
    } catch {
      ok = false;
    }
    live.busy = null;
    if (ok) {
      this.#save(appId, { mode: "signin", signedIn: true });
      live.error = null;
      await this.#autoPin(appId);
      this.d.log.info("app.connected", { appId, mode: "signin" });
      this.d.onChange();
    } else {
      live.error = timedOut ? "signin_timeout" : "signin_failed";
      this.d.log.warn("app.signin_failed", { appId, error: live.error });
    }
    await this.report(appId);
  }

  /**
   * Deletes the key and signs out of the profile the app's sign-in used. A disabled custom recipe
   * can still be disconnected (that only removes things).
   */
  async disconnect(appId: string): Promise<AppResult> {
    const e = this.entry(appId);
    if (!e) return { ok: false, reason: "unknown_app" };
    const live = this.#liveOf(appId);
    if (live.busy) return { ok: false, reason: "provider_busy" };
    const rec = this.#record(appId);
    try {
      await this.d.secrets.delete(appSecretName(appId));
    } catch {
      /* already gone */
    }
    // Only a sign-in Chalito started, and never a disabled custom recipe's command.
    if ((rec.mode === "signin" || rec.signedIn) && (!e.custom || e.enabled)) await this.#signOut(e);
    this.#save(appId, { mode: null, signedIn: false });
    live.error = null;
    live.blocked = false;
    this.d.log.info("app.disconnected", { appId });
    await this.report(appId);
    this.d.onChange();
    return { ok: true };
  }

  async #signOut(e: CatalogEntry) {
    const logout = e.recipe.signin.logoutCommand;
    if (!logout) return;
    const cmd = await this.#resolve(e.recipe.id, logout);
    if (!cmd) return;
    const r = await this.d.procs.run(cmd[0], cmd[1], { env: this.cliEnv(e.recipe.id), timeoutMs: QUICK_MS });
    if (r.code !== 0) this.d.log.warn("app.signout_failed", { appId: e.recipe.id, code: r.code });
  }

  /** The official install for this OS, if the recipe has one. */
  installFor(appId: string): RecipeInstall | null {
    const e = this.entry(appId);
    return (e && this.#spec(e)?.install) ?? null;
  }

  /** A remote install: it only runs once the person says yes on this computer (`install`). */
  async requestInstall(appId: string): Promise<AppResult> {
    const u = this.#usable(appId);
    if ("fail" in u) return u.fail;
    if (!this.#spec(u.e)?.install) return { ok: false, reason: "app_unavailable" };
    const live = this.#liveOf(appId);
    if (live.busy) return { ok: false, reason: "provider_busy" };
    live.installRequestedUntil = this.d.now() + INSTALL_CONFIRM_MS;
    live.error = null;
    this.d.log.info("app.install_requested", { appId });
    await this.report(appId);
    return { ok: true };
  }

  /** The person said no on this computer. */
  async declineInstall(appId: string): Promise<void> {
    if (!this.entry(appId)) return;
    this.#liveOf(appId).installRequestedUntil = null;
    await this.report(appId);
  }

  /** The tool (npm, brew, winget) an install runs, or null when it's missing here. */
  #installer(i: RecipeInstall): { cmd: string; args: string[] } | null {
    const find = (n: string) => which(n, this.d.env, this.#platform);
    switch (i.via) {
      case "npm": {
        const npm = find("npm");
        return npm ? { cmd: npm, args: ["install", "-g", i.ref] } : null;
      }
      case "brew": {
        const brew = find("brew");
        return brew ? { cmd: brew, args: ["install", ...(i.cask ? ["--cask"] : []), i.ref] } : null;
      }
      case "winget": {
        const winget = find("winget");
        // The person's yes in the panel (which shows the vendor's terms) is the agreement.
        return winget
          ? {
              cmd: winget,
              args: [
                "install",
                "--id",
                i.ref,
                "--exact",
                "--source",
                i.source ?? "winget",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity",
              ],
            }
          : null;
      }
      case "official-url":
        return null;
    }
  }

  /**
   * The app's official install. Call only after a local confirmation (the desktop panel's button
   * and its confirm step). npm / brew / winget run here (`installing`, then the new state); an
   * `official-url` install only opens the vendor's download page in this computer's browser, for
   * the person to install it themselves (the agent never downloads or runs an installer).
   */
  async install(appId: string): Promise<AppResult> {
    const u = this.#usable(appId);
    if ("fail" in u) return u.fail;
    const live = this.#liveOf(appId);
    if (live.busy) return { ok: false, reason: "provider_busy" };
    live.installRequestedUntil = null;
    const spec = this.#spec(u.e)?.install;
    if (!spec) {
      live.error = "install_unavailable";
      await this.report(appId);
      return { ok: false, reason: "app_unavailable" };
    }
    if (spec.via === "official-url") {
      await this.d.procs.openUrl(spec.ref).catch(() => undefined);
      this.d.log.info("app.install_page_opened", { appId });
      await this.report(appId);
      return { ok: true };
    }
    const installer = this.#installer(spec);
    if (!installer) {
      live.error = spec.via === "npm" ? "npm_missing" : "install_unavailable";
      await this.report(appId);
      return { ok: false, reason: "provider_failed" };
    }
    live.busy = "installing";
    live.error = null;
    await this.report(appId);
    this.installing = this.#runInstall(u.e, installer, spec.via).finally(() => (this.installing = null));
    return { ok: true };
  }

  /** The running install (tests wait on it). */
  installing: Promise<void> | null = null;

  async #runInstall(e: CatalogEntry, installer: { cmd: string; args: string[] }, via: string): Promise<void> {
    const appId = e.recipe.id;
    const live = this.#liveOf(appId);
    const r = await this.d.procs.run(installer.cmd, installer.args, {
      env: this.d.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    live.busy = null;
    this.#npmBin = null;
    if (r.code !== 0) {
      live.error = "install_failed";
      this.d.log.warn("app.install_failed", { appId, via, code: r.code });
      return this.report(appId);
    }
    // A fresh install replaces whatever was pinned before (CLIs only).
    const pinned = this.#bin(e) ? await this.#autoPin(appId, true) : false;
    this.d.log.info("app.installed", { appId, via, pinned });
    await this.report(appId);
    this.d.onChange();
  }

  /**
   * Opens the app on this computer: a registered driver's launcher (a managed browser profile, a
   * desktop window), else the recipe's own launch (`open -a`, the Start menu entry, a desktop
   * file, or its launch command), else a web app's start page in the default browser.
   */
  async launch(appId: string): Promise<AppResult> {
    const u = this.#usable(appId);
    if ("fail" in u) return u.fail;
    const { e } = u;
    const done = (ok: boolean): AppResult => {
      this.d.log.info("app.launch", { appId, ok });
      if (!ok) this.#liveOf(appId).error = "launch_failed";
      return ok ? { ok: true } : { ok: false, reason: "app_unavailable" };
    };
    const driver = this.d.launcher?.(appId);
    if (driver) return done(await driver().catch(() => false));
    const spec = this.#spec(e);
    const env = this.cliEnv(appId);
    if (spec?.launch?.app) {
      const app = spec.launch.app;
      const [cmd, args] =
        this.#platform === "darwin"
          ? ["open", ["-a", app]]
          : this.#platform === "win32"
            ? ["explorer.exe", [`shell:AppsFolder\\${app}`]]
            : ["gtk-launch", [app]];
      return done(await this.d.procs.launch(cmd, args, { env }));
    }
    if (spec?.launch?.command) {
      const cmd = await this.#resolve(appId, spec.launch.command);
      return done(!!cmd && (await this.d.procs.launch(cmd[0], cmd[1], { env })));
    }
    const web = e.recipe.driver.web;
    if (web) {
      await this.d.procs.openUrl(web.startUrl).catch(() => undefined);
      return done(true);
    }
    if (e.recipe.signin.url && e.recipe.signin.via === "desktop-app") {
      await this.d.procs.openUrl(e.recipe.signin.url).catch(() => undefined);
      return done(true);
    }
    return done(false);
  }

  /**
   * Pins the app's CLI (path + sha256 in the signed config) when nothing usable is pinned yet, as
   * `chalito keys set` does. With `replace`, after an install, the new binary is pinned.
   */
  async #autoPin(appId: string, replace = false): Promise<boolean> {
    const e = this.entry(appId);
    const bin = e ? this.#bin(e) : null;
    if (!bin) return false;
    const current = this.d.pins.get(appId);
    if (current && !replace && existsSync(current.path)) return true;
    const global = replace ? await this.#globalBin() : null;
    const found =
      (global ? which(bin, { ...this.d.env, PATH: global }, this.#platform) : null) ??
      (current && existsSync(current.path) ? null : await this.findCli(appId)) ??
      which(bin, this.d.env, this.#platform);
    if (!found || !statSync(found).isFile()) {
      this.#liveOf(appId).error = "pin_failed";
      return false;
    }
    try {
      await this.d.pins.set(appId, await pinClaude(found));
      return true;
    } catch (err) {
      this.#liveOf(appId).error = "pin_failed";
      this.d.log.warn("app.pin_failed", { appId, error: err instanceof Error ? err.message : "error" });
      return false;
    }
  }
}
