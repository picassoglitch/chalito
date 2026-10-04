import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyEnvelope, type SignedEnvelope } from "@chalito/crypto";
import type { Cloud, FetchFn } from "../src/cloud.js";
import { pinClaude } from "../src/claude-pin.js";
import { ConfigTamperedError, chalitoDir, writeConfig, readConfig, configPath } from "../src/config.js";
import {
  CLAUDE_MISSING,
  CLAUDE_PIN_FAILED,
  OnboardingError,
  defaultAdapters,
  runDaemon,
  type DaemonDeps,
} from "../src/daemon.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { DEFAULT_POLICY, policyHash } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { DeviceRevokedError } from "../src/device-auth.js";
import { MemorySecretStore, SECRET_NAMES } from "../src/secrets.js";
import { MemoryStore } from "../src/store.js";

const NOW = 1_790_000_000_000;

const setup = async (opts: { paired?: boolean; claude?: "pinned" | "missing"; apiKey?: boolean } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "chalito-daemon-"));
  const dir = chalitoDir(home);
  const secrets = new MemorySecretStore();
  const id = await loadOrCreateIdentity(secrets);
  if (opts.apiKey !== false) await secrets.set(SECRET_NAMES.anthropicApiKey, "sk-ant-test-key-123456");

  const bin = join(home, "bin");
  mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, "#!/bin/sh\n");
  chmodSync(claude, 0o755);
  // A different `claude` first on PATH: the daemon must never pick it up.
  const evilBin = join(home, "evil");
  mkdirSync(evilBin);
  writeFileSync(join(evilBin, "claude"), "#!/bin/sh\necho pwned\n");
  chmodSync(join(evilBin, "claude"), 0o755);
  const pin = await pinClaude(claude);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    configPath(dir),
    JSON.stringify({ apiBase: "https://api.test", firebase: { projectId: "demo", apiKey: "k" } }),
  );
  if (opts.paired !== false)
    writeConfig(
      dir,
      {
        ...readConfig(dir, {}),
        owner: "hub-user-1",
        deviceId: id.deviceId,
        ...(opts.claude === "missing" ? {} : { claude: pin }),
      },
      id.sign,
    );

  const tokens: string[] = [];
  const challenges: SignedEnvelope<{ owner: string; deviceId: string; nonce: string }>[] = [];
  let n = 0;
  const fetch: FetchFn = async (url, init) => {
    expect(url).toBe("https://api.test/v1/devices/token");
    challenges.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ customToken: `token-${++n}`, deviceId: id.deviceId }) };
  };
  const store = new MemoryStore();
  const mintRef: { mint?: () => Promise<string> } = {};
  let closed = false;
  const cloud: Cloud = {
    refreshIntervalMs: 4 * 60 * 1000,
    refresh: async () => void tokens.push(await mintRef.mint!()),
    store: () => store,
    close: async () => void (closed = true),
  };
  const logs: Record<string, unknown>[] = [];
  const refreshers: (() => void)[] = [];
  const refreshEvery: number[] = [];
  const adapterInputs: { apiKey: string | null; claudePath: string }[] = [];
  const deps: DaemonDeps = {
    home,
    env: { PATH: `${evilBin}:${bin}` },
    secrets,
    fetch,
    cloud: (_cfg, mint) => ((mintRef.mint = mint), cloud),
    adapters: (i) => (adapterInputs.push(i), {}),
    log: createLogger((l) => void logs.push(JSON.parse(l))),
    now: () => NOW,
    every: (fn, ms) => (refreshers.push(fn), refreshEvery.push(ms), { clear: () => undefined }),
    onSignal: () => undefined,
    watchFiles: false,
  };
  return {
    home,
    dir,
    id,
    secrets,
    store,
    deps,
    tokens,
    challenges,
    logs,
    refreshers,
    refreshEvery,
    adapterInputs,
    claude: pin.path,
    closed: () => closed,
  };
};

describe("chalito run (daemon)", () => {
  it("gets a device token with a signed one-time challenge, signs in, and reports policyHash + devMode", async () => {
    const s = await setup();
    const d = await runDaemon(s.deps);

    const ch = s.challenges[0]!;
    expect(ch.ctx).toBe("chalito.refresh-challenge.v1");
    expect(ch.body).toMatchObject({ owner: "hub-user-1", deviceId: s.id.deviceId });
    const ok = await verifyEnvelope(
      ch,
      "chalito.refresh-challenge.v1",
      new Map([[s.id.deviceId, s.id.sign.publicKey]]),
    );
    expect(ok.ok).toBe(true);
    expect(s.tokens).toEqual(["token-1"]);

    expect(s.store.device).toEqual({
      policyHash: policyHash(DEFAULT_POLICY),
      devMode: { on: false, toggles: [], since: null },
      lastSeenAt: NOW,
    });
    expect(s.adapterInputs).toEqual([
      { apiKey: "sk-ant-test-key-123456", claudePath: s.claude, log: expect.anything() },
    ]);
    expect(s.logs.map((l) => l.msg)).toContain("agent.ready");
    // Logs never carry the key.
    expect(JSON.stringify(s.logs)).not.toContain("sk-ant-test-key-123456");
    await d.stop();
  });

  it("routes cloud commands into the core (an unsigned one is rejected and deleted)", async () => {
    const s = await setup();
    const d = await runDaemon(s.deps);
    s.store.sendCommand("c1", { env: { body: { payload: { type: "devmode.on" } } } });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.store.commands.size).toBe(0);
    expect(s.store.deviceEvents.map((e) => e.type)).toEqual(["remote_enable.rejected"]);
    await d.stop();
  });

  it("reports policy changes (hash + notice for every client)", async () => {
    const s = await setup();
    const d = await runDaemon(s.deps);
    const next = { ...DEFAULT_POLICY, workspaces: [{ label: "w", path: join(s.home, "w") }] };
    await d.policy.set(next, "local");
    expect(s.store.device.policyHash).toBe(policyHash(next));
    expect(s.store.deviceEvents).toContainEqual({
      v: 1,
      type: "policy.changed",
      deviceId: s.id.deviceId,
      policyHash: policyHash(next),
      t: NOW,
    });
    await d.stop();
  });

  it("refreshes the device token on a timer (~50 min)", async () => {
    const s = await setup();
    const d = await runDaemon(s.deps);
    expect(s.refreshEvery).toEqual([4 * 60 * 1000]);
    s.refreshers[0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.tokens).toEqual(["token-1", "token-2"]);
    expect(s.challenges[0]!.body.nonce).not.toBe(s.challenges[1]!.body.nonce);
    await d.stop();
  });

  it("stop() (SIGTERM) unsubscribes, closes the cloud and resolves done", async () => {
    const s = await setup();
    const handlers: Partial<Record<NodeJS.Signals, () => void>> = {};
    const d = await runDaemon({ ...s.deps, onSignal: (sig, fn) => void (handlers[sig] = fn) });
    handlers.SIGTERM!();
    await d.done;
    expect(s.closed()).toBe(true);
    expect(s.logs.find((l) => l.msg === "agent.stopping")).toMatchObject({ reason: "SIGTERM" });
  });

  it("runs exactly the pinned Claude Code, never what PATH finds first", async () => {
    const s = await setup();
    const d = await runDaemon(s.deps);
    expect(s.adapterInputs[0]!.claudePath).toBe(s.claude);
    expect(s.adapterInputs[0]!.claudePath).not.toContain("evil");
    await d.stop();
  });

  it("with no pinned `claude` it fails at startup with the onboarding message, before touching the cloud", async () => {
    const s = await setup({ claude: "missing" });
    await expect(runDaemon(s.deps)).rejects.toBeInstanceOf(OnboardingError);
    await expect(runDaemon(s.deps)).rejects.toThrow(CLAUDE_MISSING.es);
    expect(CLAUDE_MISSING.es).toContain("https://code.claude.com/docs/en/setup");
    expect(CLAUDE_MISSING.es).toContain("chalito claude pin");
    expect(s.challenges).toHaveLength(0);
  });

  it("a pinned binary that changed (hash), vanished or became world-writable is an onboarding error", async () => {
    const changed = await setup();
    writeFileSync(changed.claude, "#!/bin/sh\necho swapped\n");
    await expect(runDaemon(changed.deps)).rejects.toThrow(CLAUDE_PIN_FAILED.es("hash_mismatch"));
    expect(CLAUDE_PIN_FAILED.en("hash_mismatch")).toBe(
      "Claude Code updated itself: run `chalito claude pin` again in a terminal to trust the new version.",
    );

    const gone = await setup();
    rmSync(gone.claude);
    await expect(runDaemon(gone.deps)).rejects.toBeInstanceOf(OnboardingError);

    const writable = await setup();
    chmodSync(writable.claude, 0o777);
    await expect(runDaemon(writable.deps)).rejects.toThrow(/cualquiera puede modificarlo/);
    expect(writable.challenges).toHaveLength(0);
  });

  it("an edited config.json (e.g. another claude path) is refused", async () => {
    const s = await setup();
    const raw = JSON.parse(readFileSync(configPath(s.dir), "utf8"));
    writeFileSync(configPath(s.dir), JSON.stringify({ ...raw, claude: { ...raw.claude, path: "/tmp/evil" } }));
    await expect(runDaemon(s.deps)).rejects.toBeInstanceOf(ConfigTamperedError);
    expect(s.challenges).toHaveLength(0);
  });

  it("gives the core the classifier extras: agent binaries, protected files, Claude's PATH dirs", async () => {
    const s = await setup();
    const d = await runDaemon(s.deps);
    const x = d.classifyExtras();
    expect(x.protectedPaths).toContain(s.claude);
    expect(x.pathDirs).toEqual([join(s.home, "evil"), join(s.home, "bin")]);
    for (const b of x.agentBinaries) expect(b).not.toMatch(/(^|\/)(node|nodejs|bun|tsx)$/);
    await d.stop();
  });

  it("a missing Anthropic key is logged clearly but doesn't stop the agent", async () => {
    const s = await setup({ apiKey: false });
    const d = await runDaemon(s.deps);
    expect(s.logs.find((l) => l.msg === "adapter.claude_code_unavailable")?.reason).toMatch(
      /chalito keys set anthropic/,
    );
    await d.stop();
  });

  it("refuses to start unpaired, or with a keychain identity that isn't the paired device", async () => {
    const unpaired = await setup({ paired: false });
    await expect(runDaemon(unpaired.deps)).rejects.toThrow(/chalito pair/);

    const s = await setup();
    await runDaemon({ ...s.deps, secrets: new MemorySecretStore() }).then(
      () => expect.unreachable(),
      (err: Error) => expect(err.message).toMatch(/doesn't match the paired device|signature doesn't match/),
    );
  });

  it("a trusted-clients file that fails its signature means trusting nobody", async () => {
    const s = await setup();
    writeFileSync(join(s.dir, "trusted-clients.json"), JSON.stringify({ clients: [], sig: "forged" }));
    const d = await runDaemon(s.deps);
    expect(s.logs.find((l) => l.msg === "trust.list_rejected")).toBeDefined();
    expect(s.logs.find((l) => l.msg === "agent.ready")).toMatchObject({ trustedClients: 0 });
    await d.stop();
  });

  it("publishes policy.tampered (found at load, queued until signed in) and devmode.tampered", async () => {
    const s = await setup();
    // Refused hand edit of the policy and a forged Developer-mode state, both before start.
    await runDaemon(s.deps).then((d) => d.stop());
    writeFileSync(join(s.dir, "policy.yaml"), "version: 1\n");
    writeFileSync(join(s.dir, "devmode.json"), JSON.stringify({ on: true, toggles: ["allowSudo"], since: 1 }));
    s.store.deviceEvents.length = 0;

    const d = await runDaemon(s.deps);
    await new Promise((r) => setTimeout(r, 10));
    const types = s.store.deviceEvents.map((e) => e.type);
    expect(types).toContain("policy.tampered");
    expect(types).toContain("devmode.tampered");
    expect(s.store.deviceEvents.find((e) => e.type === "devmode.tampered")).toMatchObject({
      deviceId: s.id.deviceId,
      reason: "state_signature",
      t: NOW,
    });
    expect(s.store.deviceEvents.find((e) => e.type === "policy.tampered")).toMatchObject({
      fileHash: null,
      inForceHash: policyHash(DEFAULT_POLICY),
    });
    expect(s.store.device.devMode).toEqual({ on: false, toggles: [], since: null });
    await d.stop();
  });

  it("the default Claude Code adapter logs the SDK init metadata (adapter.init)", async () => {
    const logs: Record<string, unknown>[] = [];
    const log = createLogger((l) => void logs.push(JSON.parse(l)));
    const adapter = defaultAdapters({ apiKey: "sk-ant-test-key-123456", claudePath: "/usr/bin/claude", log })[
      "claude-code"
    ] as unknown as { config: { onInit: (i: Record<string, unknown>) => void } };
    adapter.config.onInit({ sid: "s1", apiKeySource: "ANTHROPIC_API_KEY", permissionMode: "default" });
    expect(logs[0]).toMatchObject({ msg: "adapter.init", sid: "s1", apiKeySource: "ANTHROPIC_API_KEY" });
    expect(defaultAdapters({ apiKey: null, claudePath: "/usr/bin/claude", log })).toEqual({});
  });

  it("a revoked device found on a refresh tick stops the daemon with a clear log", async () => {
    const s = await setup();
    const d = await runDaemon({
      ...s.deps,
      cloud: () => ({
        refreshIntervalMs: 1000,
        refresh: (() => {
          let n = 0;
          return async () => {
            if (++n > 1) throw new DeviceRevokedError();
          };
        })(),
        store: () => s.store,
        close: async () => undefined,
      }),
    });
    s.refreshers[0]!();
    await d.done;
    expect(s.logs.find((l) => l.msg === "device.revoked")).toMatchObject({ action: "stopping" });
    expect(s.logs.find((l) => l.msg === "agent.stopping")).toMatchObject({ reason: "device_revoked" });
  });
});
