import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import type { SessionAdapter } from "@chalito/adapters";
import { ClaudeCodeAdapter } from "@chalito/adapters/claude-code";
import { loadLiabilityText } from "@chalito/config";
import { MemoryNonceStore, type NonceStore, type TrustedClientList } from "@chalito/crypto";
import type { AdapterKind } from "@chalito/protocol";
import { AgentCore } from "./agent-core.js";
import { firebaseCloud, fetchDeviceToken, type Cloud, type FetchFn } from "./cloud.js";
import { chalitoDir, ensureChalitoDir, readConfig, requirePaired, type PairedConfig } from "./config.js";
import { DevMode, DevModeStore } from "./devmode.js";
import { loadOrCreateIdentity } from "./identity.js";
import { FilePolicyHolder } from "./policy-file.js";
import { createLogger, type Logger } from "./redact.js";
import { which } from "./runner.js";
import { KeyringStore, SECRET_NAMES, type SecretStore } from "./secrets.js";
import type { AgentStore } from "./store.js";
import { TrustStore } from "./trust-store.js";

/** Custom tokens live an hour; refresh well before. */
export const TOKEN_REFRESH_MS = 50 * 60 * 1000;

export const CLAUDE_MISSING = {
  es: "No encontré Claude Code (`claude`). Instálalo con el instalador oficial de Anthropic (https://code.claude.com/docs/en/setup) o pon su ruta en ~/.chalito/config.json (claudePath).",
  en: "Claude Code (`claude`) wasn't found. Install it with Anthropic's official installer (https://code.claude.com/docs/en/setup) or set its path in ~/.chalito/config.json (claudePath).",
} as const;
export const ANTHROPIC_KEY_MISSING = {
  es: "Falta tu API key de Anthropic. Guárdala con `chalito keys set anthropic`.",
  en: "Your Anthropic API key is missing. Save it with `chalito keys set anthropic`.",
} as const;

/** A setup step the user has to do; the CLI prints it without a stack trace. */
export class OnboardingError extends Error {
  override name = "OnboardingError";
}

export interface DaemonDeps {
  home?: string;
  env?: Record<string, string | undefined>;
  secrets?: SecretStore;
  fetch?: FetchFn;
  /** Firebase in production; a fake with a MemoryStore in tests. */
  cloud?: (cfg: PairedConfig) => Cloud;
  adapters?: (input: {
    apiKey: string | null;
    claudePath: string;
    log: Logger;
  }) => Partial<Record<AdapterKind, SessionAdapter>>;
  nonces?: NonceStore;
  log?: Logger;
  now?: () => number;
  /** One-shot timers for approvals (AgentCore). */
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  /** Repeating timer for the token refresh. */
  every?: (fn: () => void, ms: number) => { clear(): void };
  /** Installs SIGTERM/SIGINT handlers; tests pass a no-op. */
  onSignal?: (sig: NodeJS.Signals, fn: () => void) => void;
  /** Off in tests that don't want fs watchers. */
  watchFiles?: boolean;
}

export interface Daemon {
  core: AgentCore;
  store: AgentStore;
  policy: FilePolicyHolder;
  stop(reason?: string): Promise<void>;
  readonly done: Promise<void>;
}

const defaultAdapters: NonNullable<DaemonDeps["adapters"]> = ({ apiKey, claudePath }) =>
  apiKey ? { "claude-code": new ClaudeCodeAdapter({ apiKey, claudePath }) } : {};

const repeat = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return { clear: () => clearInterval(t) };
};

/** `chalito run`: the long-lived agent the OS user service keeps alive (ADR 0004). */
export const runDaemon = async (deps: DaemonDeps = {}): Promise<Daemon> => {
  const env = deps.env ?? process.env;
  const dir = ensureChalitoDir(chalitoDir(deps.home ?? homedir()));
  const log = deps.log ?? createLogger();
  const now = deps.now ?? Date.now;
  const secrets = deps.secrets ?? new KeyringStore();
  const fetchFn = deps.fetch ?? (fetch as unknown as FetchFn);
  const every = deps.every ?? repeat;
  const watchFiles = deps.watchFiles ?? true;

  const cfg = requirePaired(readConfig(dir, env));
  const id = await loadOrCreateIdentity(secrets);
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
  let store: AgentStore | null = null;
  const policy = new FilePolicyHolder(dir, id.sign, {
    log,
    onChange: async (hash) => {
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

  const devStore = new DevModeStore(dir, id.sign, id.deviceId);
  const devMode = new DevMode({
    store: devStore,
    // The daemon never turns anything on: that happens in `chalito devmode on` or the desktop app.
    osAuth: { verify: async () => false },
    prompter: {
      first: async () => false,
      second: async () => false,
      liability: async () => ({ checked: false, typed: "" }),
    },
    liability: loadLiabilityText(cfg.locale),
    deviceId: id.deviceId,
    now,
    emit: async (e) => (e.type === "devmode.tampered" ? log.error : log.warn)("audit", e),
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

  // Fail fast, before touching the cloud: without Claude Code there's nothing to run.
  const claudePath = cfg.claudePath ? (existsSync(cfg.claudePath) ? cfg.claudePath : null) : which("claude", env);
  if (!claudePath) throw new OnboardingError(CLAUDE_MISSING[cfg.locale]);
  const apiKey = await secrets.get(SECRET_NAMES.anthropicApiKey);
  if (!apiKey) log.error("adapter.claude_code_unavailable", { reason: ANTHROPIC_KEY_MISSING[cfg.locale] });

  const cloud = (deps.cloud ?? ((c) => firebaseCloud(c.firebase, env)))(cfg);
  await cloud.signIn(await fetchDeviceToken(fetchFn, cfg, id, now()));
  store = cloud.store(cfg.owner, id.deviceId);
  const signedInStore = store;

  const core = new AgentCore({
    store: signedInStore,
    adapters: (deps.adapters ?? defaultAdapters)({ apiKey, claudePath, log }),
    policy,
    devMode,
    trust: () => trust,
    saveTrust: () => trustStore.save(trust),
    nonces: deps.nonces ?? new MemoryNonceStore(),
    owner: cfg.owner,
    self: { deviceId: id.deviceId, pubBox: id.pubBox, box: id.box },
    home: deps.home ?? homedir(),
    locale: () => cfg.locale,
    now,
    log,
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
  });

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
      if (name === null || name === "devmode.json") checkDevMode();
    });

  const refresh = every(() => {
    void fetchDeviceToken(fetchFn, cfg, id, now())
      .then((t) => cloud.signIn(t))
      .then(() => log.info("auth.refreshed"))
      .catch((err: unknown) =>
        log.error("auth.refresh_failed", { error: err instanceof Error ? err.message : "error" }),
      );
  }, TOKEN_REFRESH_MS);

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let stopping = false;
  const stop = async (reason = "stop") => {
    if (stopping) return done;
    stopping = true;
    log.info("agent.stopping", { reason });
    refresh.clear();
    unwatchCommands();
    policy.close();
    devWatcher?.close();
    for (const s of core.sessions.values()) {
      await s.handle.interrupt().catch(() => undefined);
      s.handle.close();
    }
    await cloud.close().catch(() => undefined);
    resolveDone();
    return done;
  };
  const onSignal = deps.onSignal ?? ((sig, fn) => process.once(sig, fn));
  onSignal("SIGTERM", () => void stop("SIGTERM"));
  onSignal("SIGINT", () => void stop("SIGINT"));

  log.info("agent.ready", {
    deviceId: id.deviceId,
    trustedClients: trust.toJSON().length,
    workspaces: policy.get().workspaces.length,
    policyHash: policy.hash,
  });
  return { core, store: signedInStore, policy, stop, done };
};
