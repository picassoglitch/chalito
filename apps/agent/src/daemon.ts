import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { basename, delimiter } from "node:path";
import { homedir } from "node:os";
import type { SessionAdapter } from "@chalito/adapters";
import { ClaudeCodeAdapter, claudeEnv } from "@chalito/adapters/claude-code";
import { loadLiabilityText } from "@chalito/config";
import type { NonceStore, TrustedClientList } from "@chalito/crypto";
import type { AdapterKind, DeviceEvent } from "@chalito/protocol";
import { AgentCore, type AgentCoreDeps } from "./agent-core.js";
import { AnchorStore } from "./anchor.js";
import { checkClaudePin } from "./claude-pin.js";
import { apiTokenSource, fetchDeviceToken, supabaseCloud, type Cloud, type FetchFn, type MintToken } from "./cloud.js";
import { chalitoDir, ensureChalitoDir, readConfig, requirePaired, type PairedConfig } from "./config.js";
import { DeviceRevokedError, SupabaseAuthTokenSource, createDeviceAuth } from "./device-auth.js";
import { DevMode, DevModeStore, type DevModeTamper } from "./devmode.js";
import { FileNonceStore } from "./nonce-store.js";
import { loadOrCreateIdentity } from "./identity.js";
import { FilePolicyHolder } from "./policy-file.js";
import { createLogger, type Logger } from "./redact.js";
import { which } from "./runner.js";
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
  /** Supabase in production; a fake with a MemoryStore in tests. */
  cloud?: (cfg: PairedConfig, mint: MintToken) => Cloud;
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
  /** What the classifier treats as the agent's own binaries, protected files and Claude's PATH. */
  classifyExtras(): { agentBinaries: string[]; protectedPaths: string[]; pathDirs: string[] };
  stop(reason?: string): Promise<void>;
  readonly done: Promise<void>;
}

export const defaultAdapters: NonNullable<DaemonDeps["adapters"]> = ({ apiKey, claudePath, log }) =>
  apiKey
    ? {
        "claude-code": new ClaudeCodeAdapter({
          apiKey,
          claudePath,
          // apiKeySource here proves the BYO key (not a claude.ai login) is in use.
          onInit: (i) => log.info("adapter.init", { ...i }),
        }),
      }
    : {};

const isInterpreter = (p: string) => /^(node|nodejs|bun|tsx)(\.exe)?$/i.test(basename(p));

const servicePlanFiles = (bin: string, home: string): string[] => {
  try {
    return servicePlan(process.platform, bin, { home }).files.map((f) => f.path);
  } catch {
    return [];
  }
};

/** ADR 0018: safety net for endorsement pointers missed while offline. */
export const ENDORSEMENT_SYNC_MS = 15 * 60 * 1000;

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

  const devStore = new DevModeStore(dir, id.sign, id.deviceId, anchor);
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
    emit: async (e) => {
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

  // Fail fast, before touching the cloud: run exactly the pinned Claude Code, never a PATH lookup.
  const pin = await checkClaudePin(cfg.claude);
  if (!pin.ok)
    throw new OnboardingError(
      pin.reason === "not_pinned" || pin.reason === "missing"
        ? CLAUDE_MISSING[cfg.locale]
        : CLAUDE_PIN_FAILED[cfg.locale](pin.reason),
    );
  const claudePath = cfg.claude!.path;
  const apiKey = await secrets.get(SECRET_NAMES.anthropicApiKey);
  if (!apiKey) log.error("adapter.claude_code_unavailable", { reason: ANTHROPIC_KEY_MISSING[cfg.locale] });

  // Supabase (ADR 0017): the only data layer.
  const mint: MintToken = () => fetchDeviceToken(fetchFn, cfg, id, now());
  const cloud = (deps.cloud ?? defaultCloud(log, secrets))(cfg, mint);
  await cloud.refresh();
  store = cloud.store(cfg.owner, id.deviceId);
  const signedInStore = store;
  for (const e of queued.splice(0)) publish(e);

  // The agent's own binaries and persistence files are hard-floor targets for the classifier.
  const agentBin = isInterpreter(process.execPath) ? which("chalito", env) : process.execPath;
  const extras = {
    agentBinaries: [...new Set([process.execPath, agentBin].filter((p): p is string => !!p && !isInterpreter(p)))],
    protectedPaths: [
      ...(agentBin ? servicePlanFiles(agentBin, deps.home ?? homedir()) : []),
      claudePath,
      ...(agentBin ? [agentBin] : []),
    ],
    pathDirs: (claudeEnv(env, "").PATH ?? "").split(delimiter).filter(Boolean),
  };
  const coreDeps: AgentCoreDeps = {
    classifyExtras: () => extras,
    store: signedInStore,
    adapters: (deps.adapters ?? defaultAdapters)({ apiKey, claudePath, log }),
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
  const core = new AgentCore(coreDeps);

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
    unwatchEndorsements();
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
  return { core, store: signedInStore, policy, classifyExtras: () => extras, stop, done };
};
