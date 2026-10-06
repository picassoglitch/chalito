import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Provider,
  type ProviderConnectMethod,
  type ProviderConnectionDoc,
  type ProviderErrorCode,
  type ProviderState,
} from "@chalito/protocol";
import { z } from "zod";
import { pinClaude, type ClaudePin } from "./claude-pin.js";
import { PROVIDER_CLI, officialLink, parseVersion, type ProviderProcs } from "./provider-cli.js";
import type { Logger } from "./redact.js";
import { which } from "./runner.js";
import type { SecretStore } from "./secrets.js";

/** A sign-in waits this long for the person to finish in the browser. */
export const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;
/** `npm install -g` of one CLI. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** A remote install request waits this long for the person to confirm it on this computer. */
export const INSTALL_CONFIRM_MS = 10 * 60 * 1000;
const QUICK_MS = 20_000;

/** What the agent remembers per provider in ~/.chalito/providers.json (0600; never a secret). */
const ProviderRecord = z.object({
  mode: z.enum(["api_key", "signin"]).nullable().default(null),
  /** A sign-in finished here (the only signal for CLIs without a status command). */
  signedIn: z.boolean().default(false),
});
const RecordFile = z.partialRecord(Provider, ProviderRecord);
type ProviderRecord = z.infer<typeof ProviderRecord>;

export interface ProviderPins {
  get(p: Provider): ClaudePin | undefined;
  /** Writes the pin into the signed config (config.ts). */
  set(p: Provider, pin: ClaudePin): Promise<void>;
}

export interface ProviderManagerDeps {
  /** ~/.chalito */
  dir: string;
  /** The agent's environment (PATH, HOME, …); CLIs get it plus their Chalito profile. */
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  secrets: SecretStore;
  procs: ProviderProcs;
  /**
   * Whether providers.yaml lets this person use the provider's own plan sign-in (daemon.ts
   * `signInAllowed`: `on`/`approved`; `owner_only` fails closed on the device).
   */
  signinAllowed: (p: Provider) => boolean;
  pins: ProviderPins;
  /** chalito.connections (AgentStore.upsertConnection). */
  report: (p: Provider, doc: ProviderConnectionDoc) => Promise<void>;
  /** Something that decides which adapters can run changed (key, sign-in, pin). */
  onChange: () => void;
  now: () => number;
  log: Logger;
}

export type ProviderResult =
  { ok: true } | { ok: false; reason: "blocked_by_policy" | "provider_busy" | "provider_failed" };

/** What the desktop panel shows per provider. */
export interface ProviderView {
  provider: Provider;
  doc: ProviderConnectionDoc;
  /** providers.yaml lets this person use the provider's plan sign-in. */
  signinAllowed: boolean;
  /** A remote install waiting for a local yes (until this time). */
  installRequestedUntil: number | null;
}

interface Live {
  busy: "installing" | "signing_in" | null;
  error: ProviderErrorCode | null;
  installRequestedUntil: number | null;
  /** The last signin asked for was refused by providers.yaml. */
  blocked: boolean;
}

/**
 * "Connect your AI" on this computer (connect contract, 2026-10-05): API keys into the OS
 * keychain, the provider's own sign-in in its own CLI, the official install, and the status
 * report. Remote commands and the desktop panel both land here; the remote ones carry no extra
 * power (an install still waits for a local yes, a sign-in still happens in this computer's
 * browser, and nothing here touches policy).
 */
export class ProviderManager {
  readonly #live = new Map<Provider, Live>();
  #npmBin: Promise<string | null> | null = null;

  constructor(private readonly d: ProviderManagerDeps) {
    for (const p of Provider.options)
      this.#live.set(p, { busy: null, error: null, installRequestedUntil: null, blocked: false });
  }

  // ---- state ---------------------------------------------------------------------

  get #file() {
    return join(this.d.dir, "providers.json");
  }

  #records(): Partial<Record<Provider, ProviderRecord>> {
    try {
      return RecordFile.parse(JSON.parse(readFileSync(this.#file, "utf8")));
    } catch {
      return {};
    }
  }

  #record(p: Provider): ProviderRecord {
    return this.#records()[p] ?? { mode: null, signedIn: false };
  }

  #save(p: Provider, r: ProviderRecord) {
    const all = { ...this.#records(), [p]: r };
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  /** The mode the adapters should use: a sign-in only while providers.yaml still allows it. */
  activeMode(p: Provider): ProviderConnectMethod | null {
    const mode = this.#record(p).mode;
    return mode === "signin" && !this.signinAllowed(p) ? null : mode;
  }

  signinAllowed(p: Provider): boolean {
    return this.d.signinAllowed(p);
  }

  /** The Chalito profile environment for a provider's CLI. */
  cliEnv(p: Provider): Record<string, string | undefined> {
    return { ...this.d.env, ...PROVIDER_CLI[p].profileEnv(this.d.dir) };
  }

  #live_(p: Provider): Live {
    return this.#live.get(p)!;
  }

  // ---- detection -----------------------------------------------------------------

  /** npm's global bin directory (where `npm install -g` puts the CLIs), found once. */
  #globalBin(): Promise<string | null> {
    return (this.#npmBin ??= (async () => {
      const npm = this.#npm();
      if (!npm) return null;
      const r = await this.d.procs.run(npm, ["prefix", "-g"], { env: this.d.env, timeoutMs: QUICK_MS });
      const prefix = r.code === 0 ? r.stdout.trim().split("\n").pop()?.trim() : "";
      if (!prefix) return null;
      return (this.d.platform ?? process.platform) === "win32" ? prefix : join(prefix, "bin");
    })());
  }

  #npm(): string | null {
    return which("npm", this.d.env, this.d.platform ?? process.platform);
  }

  /** The CLI binary: the pinned file if it's still there, else PATH, else npm's global bin. */
  async findCli(p: Provider): Promise<string | null> {
    const pin = this.d.pins.get(p);
    if (pin && existsSync(pin.path)) return pin.path;
    const platform = this.d.platform ?? process.platform;
    const bin = PROVIDER_CLI[p].bin;
    const onPath = which(bin, this.d.env, platform);
    if (onPath) return onPath;
    const global = await this.#globalBin();
    return global ? which(bin, { ...this.d.env, PATH: global }, platform) : null;
  }

  async #version(p: Provider, path: string): Promise<string | null> {
    const r = await this.d.procs.run(path, ["--version"], { env: this.cliEnv(p), timeoutMs: QUICK_MS });
    return r.code === 0 ? parseVersion(r.stdout) : null;
  }

  /** Whether the provider's own sign-in is in place for Chalito's profile. */
  async #signedIn(p: Provider, path: string): Promise<boolean> {
    const status = PROVIDER_CLI[p].status;
    if (!status) return this.#record(p).signedIn;
    const r = await this.d.procs.run(path, status.args, { env: this.cliEnv(p), timeoutMs: QUICK_MS });
    return status.signedIn(r);
  }

  /** The status doc, as reported to chalito.connections. */
  async status(p: Provider): Promise<ProviderConnectionDoc> {
    const live = this.#live_(p);
    if (live.installRequestedUntil !== null && live.installRequestedUntil <= this.d.now()) {
      live.installRequestedUntil = null;
      live.error = "install_unconfirmed";
    }
    const rec = this.#record(p);
    const path = live.busy === "installing" ? null : await this.findCli(p);
    const version = path ? await this.#version(p, path) : null;
    const installed = !!path;
    let state: ProviderState;
    if (live.busy === "installing") state = "installing";
    else if (!installed) state = "not_installed";
    else if (live.busy === "signing_in") state = "signing_in";
    else if ((rec.mode === "signin" || live.blocked) && !this.signinAllowed(p)) state = "blocked_by_policy";
    else if (rec.mode === "api_key" && (await this.#hasKey(p))) state = "connected";
    else if (rec.mode === "signin" && (await this.#signedIn(p, path))) state = "connected";
    else if (live.error) state = "error";
    else state = "needs_auth";
    return {
      mode: rec.mode,
      connected: state === "connected",
      state,
      cli: { installed, version },
      error: state === "connected" ? null : live.error,
      at: this.d.now(),
    };
  }

  async #hasKey(p: Provider): Promise<boolean> {
    try {
      return (await this.d.secrets.get(PROVIDER_CLI[p].secret)) !== null;
    } catch {
      return false;
    }
  }

  async view(): Promise<ProviderView[]> {
    return Promise.all(
      Provider.options.map(async (provider) => ({
        provider,
        doc: await this.status(provider),
        signinAllowed: this.signinAllowed(provider),
        installRequestedUntil: this.#live_(provider).installRequestedUntil,
      })),
    );
  }

  /** Reports one provider (or all) to chalito.connections; a failed write is logged. */
  async report(p?: Provider): Promise<void> {
    for (const provider of p ? [p] : Provider.options) {
      try {
        await this.d.report(provider, await this.status(provider));
      } catch (err) {
        this.d.log.warn("provider.report_failed", { provider, error: err instanceof Error ? err.message : "error" });
      }
    }
  }

  // ---- actions -------------------------------------------------------------------

  /**
   * Stores a BYO API key in the OS keychain. The key is never logged or reported; only its
   * shape is checked (a mismatch is logged, like `chalito keys set` warns).
   */
  async connectKey(p: Provider, raw: unknown): Promise<ProviderResult> {
    const live = this.#live_(p);
    const key = typeof raw === "string" ? raw.trim() : "";
    // eslint-disable-next-line no-control-regex
    if (!key || key.length > 512 || /[\s\u0000-\u001f]/.test(key)) {
      live.error = "key_invalid";
      await this.report(p);
      return { ok: false, reason: "provider_failed" };
    }
    if (!PROVIDER_CLI[p].keyShape.test(key)) this.d.log.warn("provider.key_shape_unusual", { provider: p });
    try {
      await this.d.secrets.set(PROVIDER_CLI[p].secret, key);
    } catch {
      live.error = "keychain_failed";
      await this.report(p);
      return { ok: false, reason: "provider_failed" };
    }
    this.#save(p, { ...this.#record(p), mode: "api_key" });
    live.error = null;
    live.blocked = false;
    await this.#autoPin(p);
    this.d.log.info("provider.connected", { provider: p, mode: "api_key" });
    await this.report(p);
    this.d.onChange();
    return { ok: true };
  }

  /**
   * Starts the provider's own sign-in on this computer, if providers.yaml allows it for this
   * person. Returns once it's started; the result is reported when the person finishes (or the
   * sign-in times out).
   */
  async signin(p: Provider): Promise<ProviderResult> {
    const live = this.#live_(p);
    if (!this.signinAllowed(p)) {
      live.blocked = true;
      this.d.log.warn("provider.signin_blocked", { provider: p });
      await this.report(p);
      return { ok: false, reason: "blocked_by_policy" };
    }
    if (live.busy) return { ok: false, reason: "provider_busy" };
    const path = await this.findCli(p);
    if (!path) {
      await this.report(p);
      return { ok: false, reason: "provider_failed" };
    }
    live.busy = "signing_in";
    live.blocked = false;
    live.error = null;
    await this.report(p);
    this.signingIn = this.#runSignin(p, path).finally(() => (this.signingIn = null));
    return { ok: true };
  }

  /** The running sign-in (tests wait on it). */
  signingIn: Promise<void> | null = null;

  async #runSignin(p: Provider, path: string): Promise<void> {
    const live = this.#live_(p);
    const spec = PROVIDER_CLI[p];
    const env = this.cliEnv(p);
    let ok: boolean;
    let timedOut = false;
    try {
      if ("acp" in spec.login) {
        ok = await this.d.procs.acpAuthenticate(path, spec.login.acp.args, {
          env,
          timeoutMs: SIGNIN_TIMEOUT_MS,
          methodId: spec.login.acp.methodId,
        });
      } else {
        let opened = false;
        const r = await this.d.procs.run(path, spec.login.args, {
          env,
          timeoutMs: SIGNIN_TIMEOUT_MS,
          onLine: (line) => {
            if (opened || !spec.openLinks) return;
            const url = officialLink(line, spec.linkHosts);
            if (!url) return;
            opened = true;
            void this.d.procs.openUrl(url).catch(() => undefined);
          },
        });
        timedOut = r.code === 124;
        ok = r.code === 0 && (spec.status ? await this.#signedIn(p, path) : true);
      }
    } catch {
      ok = false;
    }
    live.busy = null;
    if (ok) {
      this.#save(p, { mode: "signin", signedIn: true });
      live.error = null;
      await this.#autoPin(p);
      this.d.log.info("provider.connected", { provider: p, mode: "signin" });
      this.d.onChange();
    } else {
      live.error = timedOut ? "signin_timeout" : "signin_failed";
      this.d.log.warn("provider.signin_failed", { provider: p, error: live.error });
    }
    await this.report(p);
  }

  /** Deletes the key and signs out of Chalito's profile for this provider. */
  async disconnect(p: Provider): Promise<ProviderResult> {
    const live = this.#live_(p);
    if (live.busy) return { ok: false, reason: "provider_busy" };
    const rec = this.#record(p);
    try {
      await this.d.secrets.delete(PROVIDER_CLI[p].secret);
    } catch {
      /* already gone */
    }
    // Only a sign-in Chalito started (Grok and Gemini keep it in the person's own ~/.grok, ~/.gemini).
    if (rec.mode === "signin" || rec.signedIn) await this.#signOut(p);
    this.#save(p, { mode: null, signedIn: false });
    live.error = null;
    live.blocked = false;
    this.d.log.info("provider.disconnected", { provider: p });
    await this.report(p);
    this.d.onChange();
    return { ok: true };
  }

  async #signOut(p: Provider) {
    const logout = PROVIDER_CLI[p].logout;
    if (logout === null) return;
    const path = await this.findCli(p);
    if (!path) return;
    const r = await this.d.procs.run(path, logout.args, { env: this.cliEnv(p), timeoutMs: QUICK_MS });
    if (r.code !== 0) this.d.log.warn("provider.signout_failed", { provider: p, code: r.code });
  }

  /** A remote install: it only runs once the person says yes on this computer (`install`). */
  async requestInstall(p: Provider): Promise<ProviderResult> {
    const live = this.#live_(p);
    if (live.busy) return { ok: false, reason: "provider_busy" };
    live.installRequestedUntil = this.d.now() + INSTALL_CONFIRM_MS;
    live.error = null;
    this.d.log.info("provider.install_requested", { provider: p });
    await this.report(p);
    return { ok: true };
  }

  /** The person said no on this computer. */
  async declineInstall(p: Provider): Promise<void> {
    this.#live_(p).installRequestedUntil = null;
    await this.report(p);
  }

  /**
   * Installs the vendor's own npm package, then pins the binary. Call only after a local
   * confirmation (the desktop panel's button and its confirm step). Returns once it's started;
   * progress and the result are reported (`installing`, then the new state).
   */
  async install(p: Provider): Promise<ProviderResult> {
    const live = this.#live_(p);
    if (live.busy) return { ok: false, reason: "provider_busy" };
    live.installRequestedUntil = null;
    const npm = this.#npm();
    if (!npm) {
      live.error = "npm_missing";
      await this.report(p);
      return { ok: false, reason: "provider_failed" };
    }
    live.busy = "installing";
    live.error = null;
    await this.report(p);
    this.installing = this.#runInstall(p, npm).finally(() => (this.installing = null));
    return { ok: true };
  }

  /** The running install (tests wait on it). */
  installing: Promise<void> | null = null;

  async #runInstall(p: Provider, npm: string): Promise<void> {
    const live = this.#live_(p);
    const r = await this.d.procs.run(npm, ["install", "-g", PROVIDER_CLI[p].npmPackage], {
      env: this.d.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    live.busy = null;
    this.#npmBin = null;
    if (r.code !== 0) {
      live.error = "install_failed";
      this.d.log.warn("provider.install_failed", { provider: p, code: r.code });
      return this.report(p);
    }
    // A fresh install replaces whatever was pinned before.
    const pinned = await this.#autoPin(p, true);
    this.d.log.info("provider.installed", { provider: p, pinned });
    await this.report(p);
    this.d.onChange();
  }

  /**
   * Pins the CLI (path + sha256 in the signed config) when nothing usable is pinned yet, as
   * `chalito keys set` does. With `replace`, after an install, the new binary is pinned.
   */
  async #autoPin(p: Provider, replace = false): Promise<boolean> {
    const current = this.d.pins.get(p);
    if (current && !replace && existsSync(current.path)) return true;
    const platform = this.d.platform ?? process.platform;
    const bin = PROVIDER_CLI[p].bin;
    const global = replace ? await this.#globalBin() : null;
    const found =
      (global ? which(bin, { ...this.d.env, PATH: global }, platform) : null) ??
      (current && existsSync(current.path) ? null : await this.findCli(p)) ??
      which(bin, this.d.env, platform);
    if (!found || !statSync(found).isFile()) {
      this.#live_(p).error = "pin_failed";
      return false;
    }
    try {
      await this.d.pins.set(p, await pinClaude(found));
      return true;
    } catch (err) {
      this.#live_(p).error = "pin_failed";
      this.d.log.warn("provider.pin_failed", { provider: p, error: err instanceof Error ? err.message : "error" });
      return false;
    }
  }
}
