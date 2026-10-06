import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { homedir } from "node:os";
import type { SessionAdapter } from "@chalito/adapters";
import { ClaudeCodeAdapter, claudeEnv, type ClaudeAuth } from "@chalito/adapters/claude-code";
import { CodexAdapter } from "@chalito/adapters/codex";
import { builtinAcpRecipe } from "@chalito/adapters/acp";
import { loadLiabilityText, loadProviders } from "@chalito/config";
import type { NonceStore, TrustedClientList } from "@chalito/crypto";
import {
  PROVIDER_APP,
  isLegacyApp,
  type AdapterKind,
  type DeviceEvent,
  type Provider,
  type Recipe,
  type RecipeCatalog,
  type RecipeKind,
} from "@chalito/protocol";
import { AgentCore, type AgentCoreDeps } from "./agent-core.js";
import { AnchorStore } from "./anchor.js";
import { checkClaudePin } from "./claude-pin.js";
import { brokerPath, startBroker, type Broker } from "./computer/broker.js";
import { ComputerControl } from "./computer/control.js";
import { loadNativeDriver, type NativeDriver } from "./computer/native.js";
import { TerminalControl } from "./terminal/control.js";
import { rawShellLaunch, resolveProgram, type TerminalLaunch } from "./terminal/driver.js";
import { loadPtyBackend, type PtyBackend } from "./terminal/pty.js";
import { apiTokenSource, fetchDeviceToken, supabaseCloud, type Cloud, type FetchFn, type MintToken } from "./cloud.js";
import { chalitoDir, ensureChalitoDir, readConfig, requirePaired, writeConfig, type PairedConfig } from "./config.js";
import { DeviceRevokedError, SupabaseAuthTokenSource, createDeviceAuth } from "./device-auth.js";
import { DevMode, DevModeStore, type DevModeTamper, type OsAuth } from "./devmode.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { ipcHandlers } from "./ipc-handlers.js";
import { ipcPath, startIpcServer, type IpcServer } from "./ipc-server.js";
import { FileNonceStore } from "./nonce-store.js";
import { osAuthFor } from "./os-auth.js";
import { spawnProviderProcs, type ProviderProcs } from "./provider-cli.js";
import { AppCatalog, fetchCatalog, type CatalogEntry, type CatalogFetch } from "./apps/catalog.js";
import { AppManager } from "./apps/manager.js";
import { buildDrivers, driverFactory, type Driver } from "./drivers/registry.js";
import { loadOrCreateIdentity } from "./identity.js";
import { FilePolicyHolder } from "./policy-file.js";
import { createLogger, redactDeep, type Logger } from "./redact.js";
import { acpDriver } from "./drivers/index.js";
import { spawnRunner, which } from "./runner.js";
import { syncEndorsements, syncRevocations } from "./endorsement-sync.js";
import { openSecretStore } from "./secret-choice.js";
import { SECRET_NAMES, type SecretStore } from "./secrets.js";
import { servicePlan } from "./service.js";
import type { AgentStore } from "./store.js";
import { TrustStore } from "./trust-store.js";

export const CLAUDE_MISSING = {
  es: "No hay un Claude Code (`claude`) fijado. Instálalo con el instalador oficial de Anthropic (https://code.claude.com/docs/en/setup) y luego ejecuta `chalito claude pin` en una terminal.",
  en: "No Claude Code (`claude`) is pinned. Install it with Anthropic's official installer (https://code.claude.com/docs/en/setup), then run `chalito claude pin` in a terminal.",
} as const;
export const CLAUDE_PIN_FAILED = {
  es: (r: string) =>
    r === "hash_mismatch"
      ? "Claude Code se actualizó solo: ejecuta `chalito claude pin` otra vez en una terminal para confiar en la versión nueva."
      : `El Claude Code fijado ya no es seguro de ejecutar (${r === "world_writable" ? "cualquiera puede modificarlo" : r}). Revísalo y ejecuta \`chalito claude pin\` en una terminal.`,
  en: (r: string) =>
    r === "hash_mismatch"
      ? "Claude Code updated itself: run `chalito claude pin` again in a terminal to trust the new version."
      : `The pinned Claude Code is no longer safe to run (${r === "world_writable" ? "anyone can modify it" : r}). Check it, then run \`chalito claude pin\` in a terminal.`,
} as const;
export const CODEX_PIN_FAILED = {
  es: (r: string) =>
    r === "hash_mismatch"
      ? "Codex se actualizó: ejecuta `chalito codex pin` otra vez en una terminal para confiar en la versión nueva."
      : r === "missing" || r === "not_pinned"
        ? "El Codex fijado ya no está. Reinstálalo y ejecuta `chalito codex pin` en una terminal."
        : `El Codex fijado ya no es seguro de ejecutar (${r === "world_writable" ? "cualquiera puede modificarlo" : r}). Revísalo y ejecuta \`chalito codex pin\` en una terminal.`,
  en: (r: string) =>
    r === "hash_mismatch"
      ? "Codex was updated: run `chalito codex pin` again in a terminal to trust the new version."
      : r === "missing" || r === "not_pinned"
        ? "The pinned Codex isn't there any more. Reinstall it, then run `chalito codex pin` in a terminal."
        : `The pinned Codex is no longer safe to run (${r === "world_writable" ? "anyone can modify it" : r}). Check it, then run \`chalito codex pin\` in a terminal.`,
} as const;
export const OPENAI_KEY_MISSING = {
  es: "Codex está fijado pero falta tu API key de OpenAI. Guárdala con `chalito keys set openai`.",
  en: "Codex is pinned but your OpenAI API key is missing. Save it with `chalito keys set openai`.",
} as const;
export const ANTHROPIC_KEY_MISSING = {
  es: "Falta tu API key de Anthropic. Guárdala con `chalito keys set anthropic`.",
  en: "Your Anthropic API key is missing. Save it with `chalito keys set anthropic`.",
} as const;

const ACP_TITLE = { grok: "Grok Build", gemini: "Gemini CLI" } as const;
type AcpTool = keyof typeof ACP_TITLE;
export const ACP_PIN_FAILED = {
  es: (tool: AcpTool, r: string) =>
    r === "hash_mismatch"
      ? `${ACP_TITLE[tool]} se actualizó: ejecuta \`chalito ${tool} pin\` otra vez en una terminal para confiar en la versión nueva.`
      : r === "missing" || r === "not_pinned"
        ? `El ${ACP_TITLE[tool]} fijado ya no está. Reinstálalo y ejecuta \`chalito ${tool} pin\` en una terminal.`
        : `El ${ACP_TITLE[tool]} fijado ya no es seguro de ejecutar (${r === "world_writable" ? "cualquiera puede modificarlo" : r}). Revísalo y ejecuta \`chalito ${tool} pin\` en una terminal.`,
  en: (tool: AcpTool, r: string) =>
    r === "hash_mismatch"
      ? `${ACP_TITLE[tool]} was updated: run \`chalito ${tool} pin\` again in a terminal to trust the new version.`
      : r === "missing" || r === "not_pinned"
        ? `The pinned ${ACP_TITLE[tool]} isn't there any more. Reinstall it, then run \`chalito ${tool} pin\` in a terminal.`
        : `The pinned ${ACP_TITLE[tool]} is no longer safe to run (${r === "world_writable" ? "anyone can modify it" : r}). Check it, then run \`chalito ${tool} pin\` in a terminal.`,
} as const;
export const ACP_AUTH_MISSING = {
  es: (tool: AcpTool) =>
    tool === "grok"
      ? "Grok Build está fijado pero falta tu API key de xAI. Guárdala con `chalito keys set xai`."
      : "Gemini CLI está fijado pero falta tu API key de Gemini. Guárdala con `chalito keys set google`.",
  en: (tool: AcpTool) =>
    tool === "grok"
      ? "Grok Build is pinned but your xAI API key is missing. Save it with `chalito keys set xai`."
      : "Gemini CLI is pinned but your Gemini API key is missing. Save it with `chalito keys set google`.",
} as const;

/**
 * Whether the CLI's own sign-in (the person's plan) may be used for this provider:
 * `providers.yaml: <provider>.subscriptionLocal` is `on` or `approved`. `owner_only` and `off`
 * (and an unreadable providers.yaml) mean API key only. `owner_only` fails closed on the device:
 * the agent has no server-signed proof yet that this account is on the Chalito team, and anything
 * it read locally (an env var, a file) the person could set themselves.
 */
export const signInAllowed = (provider: Provider, load: typeof loadProviders = loadProviders): boolean => {
  try {
    const s = load().providers[provider]?.subscriptionLocal;
    return s === "on" || s === "approved";
  } catch {
    return false;
  }
};

/** A setup step the user has to do; the CLI prints it without a stack trace. */
export class OnboardingError extends Error {
  override name = "OnboardingError";
}

export interface DaemonDeps {
  home?: string;
  env?: Record<string, string | undefined>;
  secrets?: SecretStore;
  fetch?: FetchFn;
  /** Supabase in production; a fake with a MemoryStore in tests. */
  cloud?: (cfg: PairedConfig, mint: MintToken) => Cloud;
  adapters?: (input: AdapterInput) => Partial<Record<AdapterKind, SessionAdapter>>;
  nonces?: NonceStore;
  log?: Logger;
  now?: () => number;
  /** One-shot timers for approvals (AgentCore). */
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  /** Repeating timer for the token refresh. */
  every?: (fn: () => void, ms: number) => { clear(): void };
  /** Installs SIGTERM/SIGINT handlers; tests pass a no-op. */
  onSignal?: (sig: NodeJS.Signals, fn: () => void) => void;
  /** Whether a provider's CLI sign-in may be used (signInAllowed in production). */
  signInAllowed?: (provider: Provider) => boolean;
  /** Off in tests that don't want fs watchers. */
  watchFiles?: boolean;
  /** One agent per computer (instance-lock.ts); returns the release function. */
  lock?: (dir: string) => () => void;
  /**
   * The per-launch secret from the desktop app that started this agent (ipc-server.ts). Without
   * one (the OS service, a terminal) there is no IPC server.
   */
  ipcSecret?: string | null;
  /** Defaults to ~/.chalito/agent.sock (a named pipe on Windows). */
  ipcPath?: string;
  /** The OS check for enabling Developer mode from the panel (os-auth.ts in production). */
  osAuth?: () => OsAuth;
  /** The providers' CLIs (install, sign-in, status); tests pass a fake. */
  providerProcs?: ProviderProcs;
  /** Computer control's native layer (computer/native.ts in production; a fake in tests). */
  computerDriver?: () => NativeDriver;
  /** Defaults to ~/.chalito/computer.sock (a named pipe on Windows). */
  brokerPath?: string;
  /** Engine: the catalog built into the agent (tests pass their own). */
  builtinCatalog?: RecipeCatalog;
  /** Engine: keys that may sign a served catalog (production: the compiled-in CATALOG_KEYS). */
  catalogKeys?: Readonly<Record<string, string>>;
  /** Engine: GET for the served catalog; false turns the fetch off. */
  catalogFetch?: CatalogFetch | false;
  /** Remote terminal's PTY layer (terminal/pty.ts in production; a fake in tests). */
  ptyBackend?: () => PtyBackend;
  /**
   * The recipes remote terminal may open, by app id. Defaults to the engine's catalog (curated,
   * and custom recipes enabled on this computer); the raw shell is its own local toggle.
   */
  terminalRecipes?: (appId: string) => Recipe | null;
}

export interface Daemon {
  core: AgentCore;
  /** Engine: the connect engine (recipes, connect, install, launch). */
  apps: AppManager;
  catalog: AppCatalog;
  /** Engine: the drivers built for each app at the last rebuild (drivers/registry.ts). */
  drivers(): ReadonlyMap<string, { kind: RecipeKind; driver: Driver }[]>;
  /** Null when this agent runs without the desktop app (no indicator, so no computer control). */
  computer: ComputerControl | null;
  /** Null without the desktop app, like computer control (no indicator, so no remote terminal). */
  terminal: TerminalControl | null;
  store: AgentStore;
  policy: FilePolicyHolder;
  /** What the classifier treats as the agent's own binaries, protected files and Claude's PATH. */
  classifyExtras(): { agentBinaries: string[]; protectedPaths: string[]; pathDirs: string[] };
  stop(reason?: string): Promise<void>;
  readonly done: Promise<void>;
}

export interface AdapterInput {
  /** BYO Anthropic key, or Chalito's Claude Code sign-in profile (team only); null when neither. */
  apiKey: ClaudeAuth | null;
  /** The pinned Claude Code, or null when its pin is missing or failed (Codex may still run). */
  claudePath: string | null;
  /**
   * The pinned Codex with the BYO OpenAI key or, where providers.yaml allows it for this person,
   * their own `codex login` in Chalito's CODEX_HOME. Absent unless the pin checks out.
   */
  codex?: {
    path: string;
    apiKey?: string;
    chatgptLogin?: true;
    home: string;
    env: Record<string, string | undefined>;
  };
  /** Pinned Grok Build / Gemini CLI with a BYO key, or the CLI's own sign-in where allowed. */
  grok?: AcpInput;
  gemini?: AcpInput;
  log: Logger;
}

export interface AcpInput {
  path: string;
  /** BYO key (wins over sign-in). */
  apiKey?: string;
  /** No key: use the CLI's own login, which providers.yaml allows for this provider. */
  signIn: boolean;
  /** Chalito's own state dir for the CLI (~/.chalito/<tool>). */
  home: string;
  env: Record<string, string | undefined>;
}

export const defaultAdapters: NonNullable<DaemonDeps["adapters"]> = ({
  apiKey,
  claudePath,
  codex,
  grok,
  gemini,
  log,
}) => ({
  ...(apiKey && claudePath
    ? {
        "claude-code": new ClaudeCodeAdapter({
          apiKey,
          claudePath,
          // apiKeySource here shows which one is in use (ANTHROPIC_API_KEY for a BYO key).
          onInit: (i) => log.info("adapter.init", { ...i }),
        }),
      }
    : {}),
  // A BYO key goes through the adapter's env-key provider: Codex never logs in with it or stores
  // it (R-L12). A ChatGPT plan is the person's own `codex login` in Chalito's CODEX_HOME, offered
  // only where providers.yaml allows it for them (resolved before this point; D-003, connect
  // contract). Either way Codex runs with an allowlisted env and refuses app-server builds
  // outside DEFAULT_CODEX_VERSIONS.
  ...(codex
    ? {
        codex: new CodexAdapter({
          codexPath: codex.path,
          ...(codex.chatgptLogin ? { chatgptLogin: true, chatgptPlanEnabled: true } : { apiKey: codex.apiKey }),
          codexHome: codex.home,
          env: codex.env,
        }),
      }
    : {}),
  // Over ACP (D-022, D-065): the recipe-driven ACP driver; every permission request goes through
  // the gate; the key runs with Chalito's own CLI home, sign-in with the person's own login (never
  // started or read by us).
  ...Object.fromEntries(
    (["grok", "gemini"] as const).flatMap((kind) => {
      const i = kind === "grok" ? grok : gemini;
      return i
        ? [
            [
              kind,
              acpDriver({
                recipe: builtinAcpRecipe(kind),
                binPath: i.path,
                ...(i.apiKey ? { apiKey: i.apiKey } : { signIn: i.signIn }),
                home: i.home,
                env: i.env,
                log,
              }),
            ],
          ]
        : [];
    }),
  ),
});

const isInterpreter = (p: string) => /^(node|nodejs|bun|tsx)(\.exe)?$/i.test(basename(p));

/** How a coding agent starts `chalito computer mcp`: this very binary (or this script under node/tsx). */
export const computerMcpCommand = (
  execPath: string = process.execPath,
  argv: string[] = process.argv,
  execArgv: string[] = process.execArgv,
): { command: string; args: string[] } =>
  isInterpreter(execPath) && argv[1]
    ? { command: execPath, args: [...execArgv, argv[1], "computer", "mcp"] }
    : { command: execPath, args: ["computer", "mcp"] };

const servicePlanFiles = (bin: string, home: string): string[] => {
  try {
    return servicePlan(process.platform, bin, { home }).files.map((f) => f.path);
  } catch {
    return [];
  }
};

/** ADR 0018: safety net for endorsement pointers missed while offline. */
export const ENDORSEMENT_SYNC_MS = 15 * 60 * 1000;

/** Engine: how often the agent asks the api for a newer signed recipe catalog. */
export const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;

/** Presence: lastSeenAt every 5 min while running (the database skips broadcasts for last_seen-only updates). */
export const PRESENCE_HEARTBEAT_MS = 5 * 60 * 1000;

const defaultCloud =
  (log: Logger, secrets: SecretStore) =>
  (cfg: PairedConfig, mint: MintToken): Cloud => {
    const tokens =
      cfg.supabase.auth === "api-jwt"
        ? apiTokenSource(mint)
        : new SupabaseAuthTokenSource(createDeviceAuth(cfg.supabase.url, cfg.supabase.publishableKey, secrets), mint, {
            log,
          });
    return supabaseCloud(cfg.supabase, tokens, { log });
  };

const repeat = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return { clear: () => clearInterval(t) };
};

/** `chalito run`: the long-lived agent the OS user service keeps alive (ADR 0004). */
export const runDaemon = async (deps: DaemonDeps = {}): Promise<Daemon> => {
  const env = deps.env ?? process.env;
  const log = deps.log ?? createLogger();
  const dir = ensureChalitoDir(chalitoDir(deps.home ?? homedir()), (fixed) =>
    log.warn("chalito_dir.permissions_tightened", { fixed, dirMode: "0700", fileMode: "0600" }),
  );
  // Before anything else: a second agent (the OS service and the desktop app) exits here.
  const releaseLock = (deps.lock ?? acquireInstanceLock)(dir);
  try {
    return await startDaemon(deps, env, log, dir, releaseLock);
  } catch (err) {
    releaseLock();
    throw err;
  }
};

const startDaemon = async (
  deps: DaemonDeps,
  env: Record<string, string | undefined>,
  log: Logger,
  dir: string,
  releaseLock: () => void,
): Promise<Daemon> => {
  const now = deps.now ?? Date.now;
  const secrets =
    deps.secrets ?? (await openSecretStore({ env, warn: (m) => log.warn("secrets.file_store", { message: m }) }));
  const fetchFn = deps.fetch ?? (fetch as unknown as FetchFn);
  const every = deps.every ?? repeat;
  const watchFiles = deps.watchFiles ?? true;

  const id = await loadOrCreateIdentity(secrets);
  // Signed by the agent key: an unsigned edit (claude path, endpoints) doesn't take effect.
  const cfg = requirePaired(readConfig(dir, env, { keys: id.sign }));
  if (id.deviceId !== cfg.deviceId)
    throw new Error(
      "The keychain identity doesn't match the paired device in ~/.chalito/config.json. Run `chalito pair` again.",
    );
  log.info("agent.starting", { deviceId: id.deviceId, fingerprint: id.fingerprint });

  const trustStore = new TrustStore(dir, id.sign, id.deviceId);
  const loaded = await trustStore.load();
  if (loaded.tampered)
    log.error("trust.list_rejected", { file: trustStore.file, action: "trusting nobody until a local re-pair" });
  const trust: TrustedClientList = loaded.list;

  // Late-bound: the policy file and Developer mode report through the store once signed in.
  // Device events raised before that (tampering found at load) are queued.
  let store: AgentStore | null = null;
  const queued: DeviceEvent[] = [];
  const publish = (e: DeviceEvent) => {
    if (!store) return void queued.push(e);
    void store
      .publishDeviceEvent(e)
      .catch((err: unknown) =>
        log.error("device_event.publish_failed", { type: e.type, error: err instanceof Error ? err.message : "error" }),
      );
  };
  // Keychain rollback anchor for policy.lock and the Developer-mode chain; also this
  // process's high-water mark (it never moves backwards).
  const anchor = await new AnchorStore(secrets).load();
  const policy = new FilePolicyHolder(dir, id.sign, {
    anchor,
    log,
    onTamper: ({ fileHash, inForceHash }) =>
      publish({ v: 1, type: "policy.tampered", deviceId: id.deviceId, fileHash, inForceHash, t: now() }),
    onChange: async (hash) => {
      await computer?.onPolicyChange();
      await terminal?.onPolicyChange();
      if (!store) return;
      await store.updateDevice({ policyHash: hash });
      await store.publishDeviceEvent({
        v: 1,
        type: "policy.changed",
        deviceId: id.deviceId,
        policyHash: hash,
        t: now(),
      });
    },
  });

  // Late-bound: created once signed in (it reports through the store), only with the desktop app.
  let computer: ComputerControl | null = null;
  let terminal: TerminalControl | null = null;

  const devStore = new DevModeStore(dir, id.sign, id.deviceId, anchor);
  const devModeBase = {
    store: devStore,
    liability: loadLiabilityText(cfg.locale),
    deviceId: id.deviceId,
    now,
    emit: async (e: { type: string; [k: string]: unknown }) => {
      if (e.type !== "devmode.tampered") return log.warn("audit", e);
      log.error("audit", e);
      publish({
        v: 1,
        type: "devmode.tampered",
        deviceId: id.deviceId,
        reason: e.reason as DevModeTamper,
        t: now(),
      });
    },
  };
  const devMode = new DevMode({
    ...devModeBase,
    // The daemon never turns anything on by itself: that happens in `chalito devmode on`, or in
    // the desktop panel through the IPC (which asks the OS and carries the person's answers).
    osAuth: { verify: async () => false },
    prompter: {
      first: async () => false,
      second: async () => false,
      liability: async () => ({ checked: false, typed: "" }),
    },
  });
  const reportDevMode = async () => {
    if (!store) return;
    const s = devMode.state;
    await store.updateDevice({ devMode: s });
    await store.publishDeviceEvent({
      v: 1,
      type: "devmode.changed",
      deviceId: id.deviceId,
      on: s.on,
      toggles: s.toggles,
      t: now(),
    });
  };

  // Connect engine (apps/): recipes (built in, signed updates, the person's own), keys, the apps'
  // own sign-ins, installs and launches. It reports through the store once signed in.
  const toolOf = { "claude-code": "claude", codex: "codex", grok: "grok", gemini: "gemini" } as const;
  const providerOf = Object.fromEntries(Object.entries(PROVIDER_APP).map(([p, a]) => [a, p])) as Record<
    string,
    Provider
  >;
  const allowSignIn = deps.signInAllowed ?? ((p: Provider) => signInAllowed(p));
  const currentConfig = (): PairedConfig => requirePaired(readConfig(dir, env, { keys: id.sign }));
  const catalog = new AppCatalog({
    dir,
    customEnables: () => policy.get().apps?.custom ?? {},
    log,
    ...(deps.builtinCatalog ? { builtin: deps.builtinCatalog } : {}),
    ...(deps.catalogKeys ? { keys: deps.catalogKeys } : {}),
  });
  /** A recipe this computer may use: curated, or the person's own once enabled here. */
  const usableRecipe = (appId: string): Recipe | null => {
    const e = catalog.get(appId);
    return e && (!e.custom || e.enabled) ? e.recipe : null;
  };
  // The app's own plan sign-in: for the four former providers providers.yaml decides, as before
  // (D-063; their recipes mirror it); for every other app its recipe's planSignin must be "on".
  const entrySignin = (e: CatalogEntry) =>
    isLegacyApp(e.recipe.id) ? allowSignIn(providerOf[e.recipe.id]!) : e.recipe.signin.planSignin === "on";
  let launchers = new Map<string, () => Promise<boolean>>();
  let builtDrivers = new Map<string, { kind: RecipeKind; driver: Driver }[]>();
  const apps = new AppManager({
    dir,
    env,
    secrets,
    procs: deps.providerProcs ?? spawnProviderProcs(),
    entries: () => catalog.entries(),
    signinAllowed: entrySignin,
    pins: {
      get: (appId) => {
        const c = currentConfig();
        return isLegacyApp(appId) ? c[toolOf[appId]] : c.appPins?.[appId];
      },
      set: async (appId, pin) => {
        const c = currentConfig();
        writeConfig(
          dir,
          isLegacyApp(appId) ? { ...c, [toolOf[appId]]: pin } : { ...c, appPins: { ...c.appPins, [appId]: pin } },
          id.sign,
        );
      },
    },
    report: async (appId, doc) => {
      if (store) await store.upsertConnection(appId, doc);
    },
    onChange: () => void rebuildAdapters(),
    launcher: (appId) => launchers.get(appId),
    now,
    log,
  });
  /** Legacy alias: what used to be `providers.activeMode(provider)`. */
  const activeMode = (p: Provider) => apps.activeMode(PROVIDER_APP[p]);

  // Run exactly the pinned binaries, never a PATH lookup. Each provider authenticates the way the
  // person connected it: a keychain key, or (where providers.yaml allows it for them) the
  // provider's own sign-in in Chalito's profile for that CLI.
  const resolveAdapters = async (c: PairedConfig) => {
    const pin = await checkClaudePin(c.claude);
    const claudeProblem = pin.ok
      ? null
      : pin.reason === "not_pinned" || pin.reason === "missing"
        ? CLAUDE_MISSING[c.locale]
        : CLAUDE_PIN_FAILED[c.locale](pin.reason);
    const codexPin = c.codex ? await checkClaudePin(c.codex) : null;
    const codexLogin = activeMode("openai") === "signin";
    const openaiKey = c.codex && !codexLogin ? await secrets.get(SECRET_NAMES.openaiApiKey) : null;
    if (codexPin && !codexPin.ok)
      log.error("adapter.codex_unavailable", { reason: CODEX_PIN_FAILED[c.locale](codexPin.reason) });
    else if (codexPin && !openaiKey && !codexLogin)
      log.error("adapter.codex_unavailable", { reason: OPENAI_KEY_MISSING[c.locale] });
    const codexHome = apps.profileEnv("codex").CODEX_HOME ?? join(dir, "codex");
    const codex =
      codexPin?.ok && (openaiKey || codexLogin)
        ? {
            path: c.codex!.path,
            ...(codexLogin ? { chatgptLogin: true as const } : { apiKey: openaiKey! }),
            home: codexHome,
            env: { ...env },
          }
        : undefined;
    const claudePath = claudeProblem ? null : c.claude!.path;
    const apiKey: ClaudeAuth | null = !claudePath
      ? null
      : activeMode("anthropic") === "signin"
        ? { configDir: apps.profileEnv("claude-code").CLAUDE_CONFIG_DIR ?? join(dir, "claude") }
        : await secrets.get(SECRET_NAMES.anthropicApiKey);
    // Grok Build / Gemini CLI over ACP: a key unless the person chose the CLI's own sign-in
    // (providers.ts records it); with no key, the sign-in where providers.yaml allows it.
    const acpTool = async (tool: AcpTool): Promise<AcpInput | undefined> => {
      const provider = tool === "grok" ? "xai" : "google";
      const pinned = c[tool];
      if (!pinned) return undefined;
      const check = await checkClaudePin(pinned);
      if (!check.ok) {
        log.error(`adapter.${tool}_unavailable`, { reason: ACP_PIN_FAILED[c.locale](tool, check.reason) });
        return undefined;
      }
      const key =
        activeMode(provider) === "signin"
          ? null
          : await secrets.get(tool === "grok" ? SECRET_NAMES.xaiApiKey : SECRET_NAMES.googleApiKey);
      const signIn = !key && allowSignIn(provider);
      if (!key && !signIn) {
        log.error(`adapter.${tool}_unavailable`, { reason: ACP_AUTH_MISSING[c.locale](tool) });
        return undefined;
      }
      return { path: pinned.path, ...(key ? { apiKey: key } : {}), signIn, home: join(dir, tool), env: { ...env } };
    };
    const grok = await acpTool("grok");
    const gemini = await acpTool("gemini");
    return { claudeProblem, claudePath, apiKey, codex, grok, gemini };
  };

  // Fail fast, before touching the cloud. Claude Code's pin failing is fatal only when no other
  // coding agent is usable, and only for an agent the desktop app didn't start: the app's panel
  // is where the person installs and connects a provider, so that agent keeps running without one.
  const resolved = await resolveAdapters(cfg);
  const { claudeProblem, claudePath, apiKey, codex, grok, gemini } = resolved;
  if (claudeProblem && !codex && !grok && !gemini && !deps.ipcSecret) throw new OnboardingError(claudeProblem);
  if (claudeProblem) log.error("adapter.claude_code_unavailable", { reason: claudeProblem });
  if (claudePath && !apiKey)
    log.error("adapter.claude_code_unavailable", { reason: ANTHROPIC_KEY_MISSING[cfg.locale] });

  // Supabase (ADR 0017): the only data layer.
  const mint: MintToken = () => fetchDeviceToken(fetchFn, cfg, id, now());
  const cloud = (deps.cloud ?? defaultCloud(log, secrets))(cfg, mint);
  await cloud.refresh();
  store = cloud.store(cfg.owner, id.deviceId);
  const signedInStore = store;
  for (const e of queued.splice(0)) publish(e);
  void apps.report();

  // The agent's own binaries and persistence files are hard-floor targets for the classifier.
  const agentBin = isInterpreter(process.execPath) ? which("chalito", env) : process.execPath;
  const extrasFor = (c: PairedConfig, claude: string | null) => ({
    agentBinaries: [...new Set([process.execPath, agentBin].filter((p): p is string => !!p && !isInterpreter(p)))],
    protectedPaths: [
      ...(agentBin ? servicePlanFiles(agentBin, deps.home ?? homedir()) : []),
      ...(claude ? [claude] : []),
      ...[c.codex, c.grok, c.gemini].flatMap((p) => (p ? [p.path] : [])),
      ...(agentBin ? [agentBin] : []),
    ],
    pathDirs: (claudeEnv(env, "").PATH ?? "").split(delimiter).filter(Boolean),
  });
  let extras = extrasFor(cfg, claudePath);
  const coreDeps: AgentCoreDeps = {
    classifyExtras: () => extras,
    store: signedInStore,
    adapters: (deps.adapters ?? defaultAdapters)({
      apiKey,
      claudePath,
      ...(codex ? { codex } : {}),
      ...(grok ? { grok } : {}),
      ...(gemini ? { gemini } : {}),
      log,
    }),
    apps: {
      connectKey: (a, k) => apps.connectKey(a, k),
      signin: (a) => apps.signin(a),
      disconnect: (a) => apps.disconnect(a),
      requestInstall: (a) => apps.requestInstall(a),
      launch: (a) => apps.launch(a),
      report: (a) => apps.report(a),
      sessionReady: async (appId) => {
        const e = apps.entry(appId);
        if (!e) return { ok: false, reason: "unknown_app" };
        if (e.custom && !e.enabled) return { ok: false, reason: "recipe_disabled" };
        const doc = await apps.status(appId);
        return doc?.connected || doc?.state === "available" ? { ok: true } : { ok: false, reason: "adapter_disabled" };
      },
    },
    policy,
    devMode,
    trust: () => trust,
    saveTrust: () => trustStore.save(trust),
    nonces: deps.nonces ?? new FileNonceStore(dir, log),
    owner: cfg.owner,
    self: { deviceId: id.deviceId, pubBox: id.pubBox, box: id.box, sign: id.sign },
    home: deps.home ?? homedir(),
    locale: () => cfg.locale,
    now,
    log,
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
  };

  // Computer control (computer/control.ts): only when the desktop app started this agent, since
  // the app shows the on-screen indicator and holds the kill switch. The broker socket is what
  // the per-session MCP server talks to.
  const auditAgent = (type: string, meta: Record<string, unknown>) => {
    log.info(type, meta);
    void signedInStore
      .audit({
        eid: randomUUID(),
        t: now(),
        type,
        meta: redactDeep(meta) as Record<string, unknown>,
        source: "agent",
      })
      .catch((err: unknown) =>
        log.error("audit write failed", { type, error: err instanceof Error ? err.message : "error" }),
      );
  };
  let broker: Broker | null = null;
  if (deps.ipcSecret) {
    const mcp = computerMcpCommand();
    computer = new ComputerControl({
      policy: () => policy.get().computer,
      requestApproval: (sid, input) => core.requestComputerApproval(sid, input),
      interrupt: async (sid) => {
        await core.sessions.get(sid)?.handle.interrupt();
      },
      driver: deps.computerDriver ?? (() => loadNativeDriver({ runner: spawnRunner, env })),
      audit: auditAgent,
      publish: (st) =>
        publish({
          v: 1,
          type: "computer.changed",
          deviceId: id.deviceId,
          enabled: st.enabled,
          activeSessions: st.activeSessions,
          ...(st.by ? { by: st.by } : {}),
          t: now(),
        }),
      mcpLaunch: () => (broker ? { ...mcp, socket: broker.path } : null),
      now,
      locale: () => cfg.locale,
    });
    coreDeps.computer = computer;

    // Remote terminal (terminal/control.ts): also only with the desktop app, which shows the
    // indicator and holds the kill switch it shares with computer control.
    // The recipe comes from the engine's catalog on this computer (a custom one only once enabled
    // here), never from the remote command, which only names it; its driver from the registry.
    const recipes = deps.terminalRecipes ?? usableRecipe;
    terminal = new TerminalControl({
      deviceId: id.deviceId,
      policy: () => policy.get().remoteTerminal,
      workspaces: () => policy.get().workspaces,
      launch: (appId) => {
        const recipe = recipes(appId);
        const factory = driverFactory("terminal");
        if (!recipe || !factory) return null;
        const built = factory({
          recipe,
          custom: catalog.get(recipe.id)?.custom ?? false,
          bin: null,
          auth: { signIn: false },
          env,
          home: join(dir, "apps", recipe.id),
          dir,
          platform: process.platform,
          log,
        });
        return built && !(built instanceof Promise) && built.terminal ? (built.terminal as TerminalLaunch) : null;
      },
      rawShell: () => rawShellLaunch(env),
      pty: deps.ptyBackend ?? (() => loadPtyBackend()),
      resolve: (program) => resolveProgram(program, env),
      env: () => env,
      requestApproval: (tid, input, onRequested) =>
        core.approvals.request({
          sid: tid,
          risk: "HIGH",
          stepUp: true,
          origin: input.origin,
          kind: "terminal",
          details: input.details,
          onRequested,
        }),
      seal: (value, aad) => core.sealer.seal(value, aad),
      writeEvent: (e) => signedInStore.writeEvent(e),
      upsertSession: (tid, data) => signedInStore.upsertSession(tid, data),
      audit: auditAgent,
      publish: (st) =>
        publish({
          v: 1,
          type: "terminal.changed",
          deviceId: id.deviceId,
          enabled: st.enabled,
          rawShell: st.rawShell,
          activeSessions: st.activeSessions,
          ...(st.by ? { by: st.by } : {}),
          t: now(),
        }),
      now,
      locale: () => cfg.locale,
      log: (msg, meta) => log.warn(msg, meta),
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    });
    coreDeps.terminal = terminal;
  }
  const core = new AgentCore(coreDeps);
  if (computer) {
    const control = computer;
    try {
      broker = await startBroker({
        path: deps.brokerPath ?? brokerPath(dir),
        call: (token, tool, args) => control.call(token, tool, args),
      });
      log.info("computer.broker_ready", { path: broker.path, enabled: control.enabled() });
    } catch (err) {
      log.error("computer.broker_unavailable", { error: err instanceof Error ? err.message : "error" });
    }
    await control.onPolicyChange();
  }
  await terminal?.onPolicyChange();
  // The indicator watchdog: open terminals close when the desktop app stops showing it.
  const terminalWatchdog = terminal ? every(() => void terminal?.tick(), 1000) : null;

  // Engine: every usable app's drivers (drivers/registry.ts). Session adapters for apps beyond the
  // built-in four go to the core by app id; launchers back `app.launch`. Built with only what the
  // person set up here: the pinned (else detected) CLI, the keychain key or the app's own sign-in.
  const rebuildDrivers = async (): Promise<Record<string, SessionAdapter>> => {
    const next = new Map<string, { kind: RecipeKind; driver: Driver }[]>();
    const appAdapters: Record<string, SessionAdapter> = {};
    const nextLaunchers = new Map<string, () => Promise<boolean>>();
    for (const e of catalog.entries()) {
      if (e.custom && !e.enabled) continue;
      const appId = e.recipe.id;
      const mode = apps.activeMode(appId);
      const apiKey = mode === "api_key" ? await apps.apiKey(appId) : null;
      const built = await buildDrivers({
        recipe: e.recipe,
        custom: e.custom,
        bin: await apps.findCli(appId),
        auth: { ...(apiKey ? { apiKey } : {}), signIn: mode === "signin" && apps.signinAllowed(appId) },
        env: apps.cliEnv(appId),
        home: join(dir, "apps", appId),
        dir,
        platform: process.platform,
        log,
      });
      if (!built.length) continue;
      next.set(appId, built);
      // The built-in four keep their own adapters (defaultAdapters).
      const adapter = built.find((b) => b.driver.adapter)?.driver.adapter;
      if (adapter && !isLegacyApp(appId)) appAdapters[appId] = adapter;
      const launch = built.find((b) => b.driver.launch)?.driver.launch;
      if (launch) nextLaunchers.set(appId, launch);
    }
    builtDrivers = next;
    launchers = nextLaunchers;
    return appAdapters;
  };

  // An app was connected, signed out, installed or re-pinned: rebuild what can run. Running
  // sessions keep their adapter; new ones get the new one.
  let rebuilding = Promise.resolve();
  const rebuildAdapters = () =>
    (rebuilding = rebuilding.then(async () => {
      try {
        const c = currentConfig();
        const r = await resolveAdapters(c);
        extras = extrasFor(c, r.claudePath);
        core.setAdapters(
          (deps.adapters ?? defaultAdapters)({
            apiKey: r.apiKey,
            claudePath: r.claudePath,
            ...(r.codex ? { codex: r.codex } : {}),
            ...(r.grok ? { grok: r.grok } : {}),
            ...(r.gemini ? { gemini: r.gemini } : {}),
            log,
          }),
          await rebuildDrivers(),
        );
        log.info("adapters.rebuilt", {
          claudeCode: !!(r.claudePath && r.apiKey),
          codex: !!r.codex,
          grok: !!r.grok,
          gemini: !!r.gemini,
        });
      } catch (err) {
        log.error("adapters.rebuild_failed", { error: err instanceof Error ? err.message : "error" });
      }
    }));

  // ADR 0018: clients endorsed by a client this agent trusts (at start, on pointer, every 15 min).
  let syncing = false;
  const reportedRefusals = new Set<string>();
  const syncTrust = () => {
    if (syncing) return;
    syncing = true;
    // Revocations first (R-H5): a client the account revoked stops being trusted here before
    // anything it endorsed could be considered.
    void syncRevocations({
      store: signedInStore,
      trust: () => trust,
      saveTrust: () => trustStore.save(trust),
      onRevoked: (clientDeviceId) => {
        log.warn("trust.client_revoked", { clientDeviceId, by: "directory" });
        const t = now();
        void signedInStore
          .audit({
            eid: randomUUID(),
            t,
            type: "trust.client_revoked",
            meta: { clientDeviceId, by: "directory" },
            source: "agent",
          })
          .catch(() => undefined);
        void signedInStore
          .publishDeviceEvent({ v: 1, type: "trust.client_revoked", deviceId: id.deviceId, clientDeviceId, t })
          .catch((err: unknown) =>
            log.warn("trust.revocation_report_failed", { error: err instanceof Error ? err.message : "error" }),
          );
      },
    })
      .catch((err: unknown) =>
        log.warn("trust.revocation_sync_failed", { error: err instanceof Error ? err.message : "error" }),
      )
      .then(() =>
        syncEndorsements({
          store: signedInStore,
          trust: () => trust,
          saveTrust: () => trustStore.save(trust),
          now,
          onAdded: (deviceId, endorsedBy) =>
            log.info("trust.client_endorsed", { clientDeviceId: deviceId, endorsedBy }),
          // R-L13: a refusal is never silent. Logged, audited, and published to the person's clients.
          onRefused: (clientDeviceId, endorsedBy, reason) => {
            log.warn("trust.endorsement_refused", { clientDeviceId, endorsedBy, reason });
            const t = now();
            void signedInStore
              .publishDeviceEvent({
                v: 1,
                type: "trust.endorsement_refused",
                deviceId: id.deviceId,
                clientDeviceId,
                endorsedBy,
                reason,
                t,
              })
              .catch((err: unknown) =>
                log.warn("trust.refusal_report_failed", { error: err instanceof Error ? err.message : "error" }),
              );
          },
          reported: reportedRefusals,
        }),
      )
      .catch((err: unknown) =>
        log.warn("trust.endorsement_sync_failed", { error: err instanceof Error ? err.message : "error" }),
      )
      .finally(() => {
        syncing = false;
      });
  };
  const unwatchEndorsements = signedInStore.watchEndorsements(syncTrust);
  syncTrust();

  const unwatchCommands = signedInStore.watchCommands((cid, doc) => {
    void core.handleCommand(cid, doc).then((r) => {
      if (!r.ok) log.warn("command.not_applied", { cid, reason: r.reason });
    });
  });
  await signedInStore.updateDevice({ policyHash: policy.hash, devMode: devMode.state, lastSeenAt: now() });
  if (watchFiles) policy.watch();

  // devmode.json is written by `chalito devmode …` in another process.
  let devWatcher: FSWatcher | null = null;
  let lastDevMode = JSON.stringify(devMode.state);
  const checkDevMode = () => {
    const cur = JSON.stringify(devMode.state);
    if (cur === lastDevMode) return;
    lastDevMode = cur;
    void reportDevMode().catch((err: unknown) =>
      log.error("devmode.report_failed", { error: err instanceof Error ? err.message : "error" }),
    );
  };
  if (watchFiles)
    devWatcher = watch(dir, (_e, name) => {
      // Another process (`chalito devmode …`) also moved the keychain head: reload it first.
      if (name === null || name === "devmode.json") void anchor.load().then(checkDevMode, checkDevMode);
    });

  const refresh = every(() => {
    void cloud
      .refresh()
      .then(() => log.info("auth.refreshed"))
      .catch((err: unknown) => {
        if (err instanceof DeviceRevokedError) {
          // The account removed this computer: nothing it does can be authorized any more.
          log.error("device.revoked", { message: err.message, action: "stopping" });
          void stop("device_revoked");
          return;
        }
        log.error("auth.refresh_failed", { error: err instanceof Error ? err.message : "error" });
      });
  }, cloud.refreshIntervalMs);

  const heartbeat = every(() => {
    void signedInStore
      .updateDevice({ lastSeenAt: now() })
      .catch((err: unknown) =>
        log.warn("presence.heartbeat_failed", { error: err instanceof Error ? err.message : "error" }),
      );
  }, PRESENCE_HEARTBEAT_MS);
  const endorsementSync = every(syncTrust, ENDORSEMENT_SYNC_MS);

  // Engine: curated recipe updates from the api, used only when a compiled-in key verifies them.
  const catalogFetch: CatalogFetch | false =
    deps.catalogFetch ?? ((url) => fetch(url, { headers: { accept: "application/json" } }));
  const refreshCatalog = () => {
    if (!catalogFetch) return;
    void fetchCatalog(catalogFetch, cfg.apiBase)
      .then(async (raw) => {
        if (raw === null) return;
        const r = await catalog.offer(raw);
        if (r.ok && r.applied) {
          await apps.report();
          void rebuildAdapters();
        }
      })
      .catch((err: unknown) =>
        log.warn("recipes.catalog_refresh_failed", { error: err instanceof Error ? err.message : "error" }),
      );
  };
  refreshCatalog();
  const catalogRefresh = catalogFetch ? every(refreshCatalog, CATALOG_REFRESH_MS) : { clear: () => undefined };
  // The registered drivers' adapters and launchers (the built-in four are already resolved above).
  void rebuildDrivers()
    .then((appAdapters) => core.setAppAdapters(appAdapters))
    .catch((err: unknown) =>
      log.error("drivers.build_failed", { error: err instanceof Error ? err.message : "error" }),
    );

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let stopping = false;
  const stop = async (reason = "stop") => {
    if (stopping) return done;
    stopping = true;
    log.info("agent.stopping", { reason });
    refresh.clear();
    heartbeat.clear();
    endorsementSync.clear();
    catalogRefresh.clear();
    unwatchEndorsements();
    unwatchCommands();
    policy.close();
    devWatcher?.close();
    const st = computer?.status();
    if (st && (st.active.length || st.pending.length)) await computer?.kill("agent_stop").catch(() => undefined);
    terminalWatchdog?.clear();
    await terminal?.kill("agent_stop").catch(() => undefined);
    for (const s of core.sessions.values()) {
      await s.handle.interrupt().catch(() => undefined);
      s.handle.close();
    }
    await broker?.close().catch(() => undefined);
    await ipc?.close().catch(() => undefined);
    await cloud.close().catch(() => undefined);
    releaseLock();
    resolveDone();
    return done;
  };
  const onSignal = deps.onSignal ?? ((sig, fn) => process.once(sig, fn));
  onSignal("SIGTERM", () => void stop("SIGTERM"));
  onSignal("SIGINT", () => void stop("SIGINT"));

  // The desktop panel's local IPC (only with the app's secret).
  let ipc: IpcServer | null = null;
  if (deps.ipcSecret) {
    try {
      ipc = await startIpcServer({
        path: deps.ipcPath ?? ipcPath(dir),
        secret: deps.ipcSecret,
        handlers: ipcHandlers({
          policy,
          devMode,
          devModeDeps: devModeBase,
          osAuth:
            deps.osAuth ??
            (() =>
              osAuthFor(process.platform, spawnRunner, (m) => log.warn("os_auth.notice", { message: m }), cfg.locale)),
          liability: devModeBase.liability,
          locale: () => cfg.locale,
          store: signedInStore,
          now,
          reportDevMode,
          apps,
          catalog,
          computer,
          terminal,
          audit: auditAgent,
        }),
        onError: (method, err) =>
          log.warn("ipc.request_failed", { method, error: err instanceof Error ? err.message : "error" }),
      });
      log.info("ipc.ready", { path: ipc.path });
    } catch (err) {
      log.error("ipc.unavailable", { error: err instanceof Error ? err.message : "error" });
    }
  }

  log.info("agent.ready", {
    deviceId: id.deviceId,
    trustedClients: trust.toJSON().length,
    workspaces: policy.get().workspaces.length,
    policyHash: policy.hash,
  });
  return {
    core,
    apps,
    catalog,
    drivers: () => builtDrivers,
    computer,
    terminal,
    store: signedInStore,
    policy,
    classifyExtras: () => extras,
    stop,
    done,
  };
};
