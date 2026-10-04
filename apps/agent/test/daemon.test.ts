import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyEnvelope, type SignedEnvelope } from "@chalito/crypto";
import type { Cloud, FetchFn } from "../src/cloud.js";
import { chalitoDir, writeConfig, readConfig, configPath } from "../src/config.js";
import { CLAUDE_MISSING, OnboardingError, TOKEN_REFRESH_MS, runDaemon, type DaemonDeps } from "../src/daemon.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { DEFAULT_POLICY, policyHash } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemorySecretStore, SECRET_NAMES } from "../src/secrets.js";
import { MemoryStore } from "../src/store.js";

const NOW = 1_790_000_000_000;

const setup = async (opts: { paired?: boolean; claude?: "path" | "config" | "missing"; apiKey?: boolean } = {}) => {
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

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    configPath(dir),
    JSON.stringify({ apiBase: "https://api.test", firebase: { projectId: "demo", apiKey: "k" } }),
  );
  if (opts.paired !== false)
    writeConfig(dir, {
      ...readConfig(dir, {}),
      owner: "hub-user-1",
      deviceId: id.deviceId,
      ...(opts.claude === "config" ? { claudePath: claude } : {}),
    });

  const tokens: string[] = [];
  const challenges: SignedEnvelope<{ owner: string; deviceId: string; nonce: string }>[] = [];
  let n = 0;
  const fetch: FetchFn = async (url, init) => {
    expect(url).toBe("https://api.test/v1/devices/token");
    challenges.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ customToken: `token-${++n}`, deviceId: id.deviceId }) };
  };
  const store = new MemoryStore();
  let closed = false;
  const cloud: Cloud = {
    signIn: async (t) => void tokens.push(t),
    store: () => store,
    close: async () => void (closed = true),
  };
  const logs: Record<string, unknown>[] = [];
  const refreshers: (() => void)[] = [];
  const adapterInputs: { apiKey: string | null; claudePath: string }[] = [];
  const deps: DaemonDeps = {
    home,
    env: { PATH: opts.claude === "path" || opts.claude === undefined ? bin : join(home, "nowhere") },
    secrets,
    fetch,
    cloud: () => cloud,
    adapters: (i) => (adapterInputs.push(i), {}),
    log: createLogger((l) => void logs.push(JSON.parse(l))),
    now: () => NOW,
    every: (fn) => (refreshers.push(fn), { clear: () => undefined }),
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
    adapterInputs,
    claude,
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
    expect(TOKEN_REFRESH_MS).toBe(50 * 60 * 1000);
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

  it("uses the configured claudePath when set", async () => {
    const s = await setup({ claude: "config" });
    const d = await runDaemon(s.deps);
    expect(s.adapterInputs[0]!.claudePath).toBe(s.claude);
    await d.stop();
  });

  it("without a `claude` binary it fails at startup with the onboarding message, before touching the cloud", async () => {
    const s = await setup({ claude: "missing" });
    await expect(runDaemon(s.deps)).rejects.toBeInstanceOf(OnboardingError);
    await expect(runDaemon(s.deps)).rejects.toThrow(CLAUDE_MISSING.es);
    expect(CLAUDE_MISSING.es).toContain("https://code.claude.com/docs/en/setup");
    expect(s.challenges).toHaveLength(0);
  });

  it("a configured claudePath that doesn't exist is also an onboarding error", async () => {
    const s = await setup({ claude: "config" });
    const cfg = readConfig(s.dir, {});
    writeConfig(s.dir, { ...cfg, claudePath: join(s.home, "gone", "claude") });
    await expect(runDaemon(s.deps)).rejects.toBeInstanceOf(OnboardingError);
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
      (err: Error) => expect(err.message).toMatch(/doesn't match the paired device/),
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
});
