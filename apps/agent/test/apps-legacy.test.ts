import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConnectionDoc, PROVIDER_APP, type Provider } from "@chalito/protocol";
import type { ClaudePin } from "../src/claude-pin.js";
import { officialLink, parseVersion, viaShell } from "../src/provider-cli.js";
import { signInAllowed } from "../src/daemon.js";
import { BUILTIN_CATALOG, type CatalogEntry } from "../src/apps/catalog.js";
import { AppManager, INSTALL_CONFIRM_MS } from "../src/apps/manager.js";

/**
 * #30's ProviderManager behaviour, now through the connect engine (AppManager driven by the
 * built-in recipes). Every case still speaks in providers, mapped to their app ids, which is
 * what the provider.* aliases do.
 */
const LEGACY = Object.values(PROVIDER_APP) as string[];
const PROVIDER_OF = Object.fromEntries(Object.entries(PROVIDER_APP).map(([p, a]) => [a, p])) as Record<
  string,
  Provider
>;
const legacyEntries = (): CatalogEntry[] =>
  BUILTIN_CATALOG.recipes
    .filter((r) => LEGACY.includes(r.id))
    .sort((a, b) => LEGACY.indexOf(a.id) - LEGACY.indexOf(b.id))
    .map((recipe) => ({ recipe, custom: false, enabled: true }));

type SubscriptionLocal = "off" | "owner_only" | "approved" | "on";
import { createLogger } from "../src/redact.js";
import { MemorySecretStore, SECRET_NAMES } from "../src/secrets.js";
import { fakeProviderProcs, type ProcCall } from "./fake-provider-procs.js";

const NOW = 1_790_000_000_000;

const exe = (dir: string, name: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n# ${name}\n`);
  chmodSync(p, 0o755);
  return p;
};

const setup = (
  o: {
    installed?: ("claude" | "codex" | "grok" | "gemini")[];
    npm?: boolean;
    settings?: Partial<Record<Provider, SubscriptionLocal>>;
    answer?: Parameters<typeof fakeProviderProcs>[0];
  } = {},
) => {
  const home = mkdtempSync(join(tmpdir(), "chalito-providers-"));
  const dir = join(home, ".chalito");
  const bin = join(home, "bin");
  const npmGlobal = join(home, "npm-global");
  mkdirSync(dir, { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(npmGlobal, "bin"), { recursive: true });
  for (const b of o.installed ?? []) exe(bin, b);
  if (o.npm !== false) exe(bin, "npm");
  const fake = fakeProviderProcs((c) => {
    if (c.args.join(" ") === "prefix -g") return { stdout: `${npmGlobal}\n` };
    return o.answer?.(c) ?? {};
  });
  const secrets = new MemorySecretStore();
  const pins = new Map<Provider, ClaudePin>();
  const reports: [Provider, AppConnectionDoc][] = [];
  const logs: string[] = [];
  let changes = 0;
  let now = NOW;
  const settings: Record<Provider, SubscriptionLocal> = {
    anthropic: "owner_only",
    openai: "owner_only",
    xai: "on",
    google: "on",
    ...o.settings,
  };
  const allowed = (p: Provider) =>
    signInAllowed(p, () => ({ providers: { [p]: { subscriptionLocal: settings[p] } } }) as never);
  const mgr = new AppManager({
    dir,
    env: { PATH: bin, HOME: home },
    platform: "linux",
    secrets,
    procs: fake.procs,
    entries: legacyEntries,
    // The daemon's rule for the former providers: providers.yaml decides (their recipes mirror it).
    signinAllowed: (e) => allowed(PROVIDER_OF[e.recipe.id]!),
    pins: { get: (a) => pins.get(PROVIDER_OF[a]!), set: async (a, pin) => void pins.set(PROVIDER_OF[a]!, pin) },
    report: async (a, doc) => void reports.push([PROVIDER_OF[a]!, AppConnectionDoc.parse(doc)]),
    onChange: () => void changes++,
    now: () => now,
    log: createLogger((l) => logs.push(l)),
  });
  // The provider.* aliases: provider → app id.
  const A = (p: Provider) => PROVIDER_APP[p];
  const m = {
    connectKey: (p: Provider, k: unknown) => mgr.connectKey(A(p), k),
    signin: (p: Provider) => mgr.signin(A(p)),
    disconnect: (p: Provider) => mgr.disconnect(A(p)),
    requestInstall: (p: Provider) => mgr.requestInstall(A(p)),
    install: (p: Provider) => mgr.install(A(p)),
    activeMode: (p: Provider) => mgr.activeMode(A(p)),
    status: async (p: Provider) => (await mgr.status(A(p)))!,
    view: async () => (await mgr.view()).map((v) => ({ ...v, provider: PROVIDER_OF[v.appId]! })),
    report: (p?: Provider) => mgr.report(p && A(p)),
    get signingIn() {
      return mgr.signingIn;
    },
    get installing() {
      return mgr.installing;
    },
  };
  const last = (p: Provider) => reports.filter(([q]) => q === p).at(-1)?.[1];
  return {
    m,
    dir,
    bin,
    npmGlobal,
    fake,
    secrets,
    pins,
    reports,
    logs,
    last,
    changes: () => changes,
    advance: (ms: number) => void (now += ms),
  };
};

const cmd = (c: ProcCall) => `${c.cmd.split("/").pop()} ${c.args.join(" ")}`;

describe("plan sign-in gate (providers.yaml subscriptionLocal)", () => {
  it("on/approved allow it; owner_only fails closed on the device (no server-signed team claim yet)", () => {
    const yaml = (v: SubscriptionLocal) => () => ({ providers: { xai: { subscriptionLocal: v } } }) as never;
    expect(signInAllowed("xai", yaml("on"))).toBe(true);
    expect(signInAllowed("xai", yaml("approved"))).toBe(true);
    expect(signInAllowed("xai", yaml("owner_only"))).toBe(false);
    expect(signInAllowed("xai", yaml("off"))).toBe(false);
  });
});

describe("provider CLI helpers", () => {
  it("opens only links on the provider's own hosts", () => {
    const hosts = BUILTIN_CATALOG.recipes.find((r) => r.id === "grok")!.signin.linkHosts!;
    expect(officialLink("  https://accounts.x.ai/oauth2/device?user_code=26ZT-74YM", hosts)).toBe(
      "https://accounts.x.ai/oauth2/device?user_code=26ZT-74YM",
    );
    expect(officialLink("https://accounts.x.ai.evil.com/x", hosts)).toBeNull();
    expect(officialLink("http://accounts.x.ai/x", hosts)).toBeNull();
    expect(officialLink("no link here", hosts)).toBeNull();
  });

  it("reads a version from --version output", () => {
    expect(parseVersion("codex-cli 0.160.1\n")).toBe("0.160.1");
    expect(parseVersion("2.1.291 (Claude Code)")).toBe("2.1.291");
    expect(parseVersion("grok 1.0.46 (2765805b9442)")).toBe("1.0.46");
    expect(parseVersion("nothing")).toBeNull();
  });
});

describe("AppManager on the former providers (provider.* aliases)", () => {
  it("reports every provider: not installed, or installed and waiting for a key or sign-in", async () => {
    const s = setup({ installed: ["codex"] });
    await s.m.report();
    expect(s.reports.map(([p]) => p)).toEqual(["anthropic", "openai", "xai", "google"]);
    expect(s.last("anthropic")).toEqual({
      mode: null,
      connected: false,
      state: "not_installed",
      cli: { installed: false, version: null },
      error: null,
      at: NOW,
      kind: "claude-sdk",
      custom: false,
    });
    expect(s.last("openai")).toMatchObject({ state: "needs_auth", cli: { installed: true, version: "1.2.3" } });
  });

  it("an API key goes to the keychain, pins the CLI and connects; the key is never logged or reported", async () => {
    const s = setup({ installed: ["codex"] });
    expect(await s.m.connectKey("openai", "  sk-proj-secret-123  ")).toEqual({ ok: true });
    expect(await s.secrets.get(SECRET_NAMES.openaiApiKey)).toBe("sk-proj-secret-123");
    expect(s.last("openai")).toMatchObject({ mode: "api_key", connected: true, state: "connected", error: null });
    expect(s.pins.get("openai")?.path).toBe(join(s.bin, "codex"));
    expect(s.changes()).toBe(1);
    expect(JSON.stringify([s.reports, s.logs])).not.toContain("sk-proj-secret");
    expect(readFileSync(join(s.dir, "apps.json"), "utf8")).not.toContain("sk-proj");
  });

  it("refuses an empty or multi-line key, and a key for Gemini lands in its own keychain slot", async () => {
    const s = setup({ installed: ["gemini"] });
    expect(await s.m.connectKey("google", "")).toEqual({ ok: false, reason: "provider_failed" });
    expect(await s.m.connectKey("google", "AIza\nrm -rf")).toEqual({ ok: false, reason: "provider_failed" });
    expect(s.last("google")).toMatchObject({ state: "error", error: "key_invalid" });
    expect(await s.m.connectKey("google", "AIzaSyTest")).toEqual({ ok: true });
    expect(await s.secrets.get(SECRET_NAMES.googleApiKey)).toBe("AIzaSyTest");
  });

  it("Claude sign-in (owner_only) is blocked_by_policy on the device and nothing runs", async () => {
    const s = setup({ installed: ["claude"] });
    expect(await s.m.signin("anthropic")).toEqual({ ok: false, reason: "blocked_by_policy" });
    expect(s.last("anthropic")).toMatchObject({ state: "blocked_by_policy", connected: false });
    expect(s.fake.calls.some((c) => c.args[0] === "auth" && c.args[1] === "login")).toBe(false);
  });

  it("where allowed, Claude signs in with `claude auth login` in Chalito's own Claude Code profile", async () => {
    const s = setup({
      installed: ["claude"],
      settings: { anthropic: "approved" },
      answer: (c) => (c.args.join(" ") === "auth status --json" ? { stdout: JSON.stringify({ loggedIn: true }) } : {}),
    });
    expect(await s.m.signin("anthropic")).toEqual({ ok: true });
    expect(s.last("anthropic")).toMatchObject({ state: "signing_in" });
    await s.m.signingIn;
    const login = s.fake.calls.find((c) => c.args[1] === "login")!;
    expect(cmd(login)).toBe("claude auth login --claudeai");
    expect(login.env.CLAUDE_CONFIG_DIR).toBe(join(s.dir, "claude"));
    expect(s.last("anthropic")).toMatchObject({ mode: "signin", state: "connected" });
    expect(s.m.activeMode("anthropic")).toBe("signin");
    expect(s.changes()).toBe(1);
  });

  it("Codex: `codex login` in Chalito's CODEX_HOME, confirmed by `codex login status`", async () => {
    let signedIn = false;
    const s = setup({
      installed: ["codex"],
      settings: { openai: "approved" },
      answer: (c) => {
        if (c.args.join(" ") === "login") signedIn = true;
        if (c.args.join(" ") === "login status") return { code: signedIn ? 0 : 1 };
        return {};
      },
    });
    await s.m.signin("openai");
    await s.m.signingIn;
    expect(s.fake.calls.find((c) => c.args.join(" ") === "login")?.env.CODEX_HOME).toBe(join(s.dir, "codex"));
    expect(s.last("openai")).toMatchObject({ mode: "signin", state: "connected" });
  });

  it("a sign-in that fails or times out is reported as an error code, never the CLI's output", async () => {
    const s = setup({
      installed: ["codex", "grok"],
      settings: { openai: "approved" },
      answer: (c) =>
        c.args[0] === "login" && c.args.length === 1
          ? { code: c.cmd.endsWith("grok") ? 124 : 1, stderr: "Error: token /home/me/x" }
          : {},
    });
    await s.m.signin("openai");
    await s.m.signingIn;
    expect(s.last("openai")).toMatchObject({ state: "error", error: "signin_failed", mode: null });
    await s.m.signin("xai");
    await s.m.signingIn;
    expect(s.last("xai")).toMatchObject({ state: "error", error: "signin_timeout" });
    expect(JSON.stringify(s.reports)).not.toContain("/home/me");
  });

  it("Grok: `grok login` prints an accounts.x.ai link without a terminal; the agent opens only that link", async () => {
    const s = setup({
      installed: ["grok"],
      answer: (c) =>
        c.args[0] === "login"
          ? { lines: ["See https://evil.example/phish", "  https://accounts.x.ai/oauth2/device?user_code=AB-CD"] }
          : {},
    });
    await s.m.signin("xai");
    await s.m.signingIn;
    expect(s.fake.opened).toEqual(["https://accounts.x.ai/oauth2/device?user_code=AB-CD"]);
    expect(s.last("xai")).toMatchObject({ mode: "signin", state: "connected" });
  });

  it("Gemini: Google sign-in through Gemini CLI's ACP authenticate (oauth-personal), the person's own login", async () => {
    const s = setup({ installed: ["gemini"] });
    await s.m.signin("google");
    await s.m.signingIn;
    expect(s.fake.acp).toMatchObject([{ args: ["--acp"], methodId: "oauth-personal" }]);
    // The ACP adapter's sign-in sessions read the same ~/.gemini login.
    expect(s.fake.acp[0]!.env.GEMINI_CLI_HOME).toBeUndefined();
    expect(s.last("google")).toMatchObject({ mode: "signin", state: "connected" });
  });

  it("a sign-in stops counting once providers.yaml no longer allows it for this person", async () => {
    const s = setup({ installed: ["gemini"] });
    await s.m.signin("google");
    await s.m.signingIn;
    const off = setup({ installed: ["gemini"], settings: { google: "off" } });
    writeFileSync(join(off.dir, "apps.json"), readFileSync(join(s.dir, "apps.json")));
    expect(off.m.activeMode("google")).toBeNull();
    expect((await off.m.status("google")).state).toBe("blocked_by_policy");
  });

  it("disconnect deletes the key, signs out only a sign-in Chalito made, and reports needs_auth", async () => {
    const s = setup({ installed: ["grok", "codex"], settings: { openai: "approved" } });
    await s.m.connectKey("xai", "xai-test");
    await s.m.disconnect("xai");
    expect(await s.secrets.get(SECRET_NAMES.xaiApiKey)).toBeNull();
    // The person's own Grok login (~/.grok) isn't Chalito's to sign out of.
    expect(s.fake.calls.some((c) => c.args[0] === "logout")).toBe(false);
    expect(s.last("xai")).toMatchObject({ mode: null, state: "needs_auth" });

    await s.m.signin("openai");
    await s.m.signingIn;
    await s.m.disconnect("openai");
    const logout = s.fake.calls.find((c) => c.args[0] === "logout")!;
    expect(cmd(logout)).toBe("codex logout");
    expect(logout.env.CODEX_HOME).toBe(join(s.dir, "codex"));
  });

  it("disconnecting Gemini forgets the sign-in but leaves the person's own ~/.gemini alone", async () => {
    const s = setup({ installed: ["gemini"] });
    await s.m.signin("google");
    await s.m.signingIn;
    await s.m.disconnect("google");
    expect(s.fake.calls.some((c) => c.cmd.endsWith("gemini") && c.args[0] !== "--version")).toBe(false);
    expect(s.m.activeMode("google")).toBeNull();
  });

  it("a remote install only asks: npm runs after the local yes, then the new binary is pinned", async () => {
    const s = setup({
      answer: (c) => {
        if (c.args[0] === "install") exe(join(s.npmGlobal, "bin"), "codex");
        return {};
      },
    });
    expect(await s.m.requestInstall("openai")).toEqual({ ok: true });
    expect(s.fake.calls.some((c) => c.args[0] === "install")).toBe(false);
    expect((await s.m.view()).find((v) => v.provider === "openai")?.installRequestedUntil).toBe(
      NOW + INSTALL_CONFIRM_MS,
    );

    expect(await s.m.install("openai")).toEqual({ ok: true });
    expect(s.last("openai")).toMatchObject({ state: "installing" });
    await s.m.installing;
    expect(s.fake.calls.map(cmd)).toContain("npm install -g @openai/codex");
    expect(s.pins.get("openai")?.path).toBe(join(s.npmGlobal, "bin", "codex"));
    expect(s.last("openai")).toMatchObject({ state: "needs_auth", cli: { installed: true } });
  });

  it("an install nobody confirms expires; a failed install or a missing npm is an error code", async () => {
    const s = setup({ answer: (c) => (c.args[0] === "install" ? { code: 1, stderr: "EACCES" } : {}) });
    await s.m.requestInstall("google");
    s.advance(INSTALL_CONFIRM_MS + 1);
    expect(await s.m.status("google")).toMatchObject({ state: "not_installed", error: "install_unconfirmed" });
    await s.m.install("google");
    await s.m.installing;
    expect(s.last("google")).toMatchObject({ state: "not_installed", error: "install_failed" });

    const noNpm = setup({ npm: false });
    expect(await noNpm.m.install("xai")).toEqual({ ok: false, reason: "provider_failed" });
    expect(noNpm.last("xai")).toMatchObject({ error: "npm_missing" });
  });

  it("one install or sign-in at a time per provider", async () => {
    const s = setup({ installed: ["gemini"] });
    let release!: (ok: boolean) => void;
    s.fake.procs.acpAuthenticate = () => new Promise((r) => (release = r));
    await s.m.signin("google");
    expect(await s.m.signin("google")).toEqual({ ok: false, reason: "provider_busy" });
    expect(await s.m.install("google")).toEqual({ ok: false, reason: "provider_busy" });
    release(true);
    await s.m.signingIn;
  });
});

describe("Windows .cmd launchers (cmd.exe joins the command line)", () => {
  it("quotes paths and args with spaces; refuses anything cmd.exe would interpret", () => {
    expect(viaShell("linux", "/usr/bin/npm", ["i", "a&b"])).toEqual({
      cmd: "/usr/bin/npm",
      args: ["i", "a&b"],
      shell: false,
    });
    expect(viaShell("win32", "C:\\x\\codex.exe", ["a b"])).toMatchObject({ shell: false, args: ["a b"] });
    expect(viaShell("win32", "C:\\Program Files\\nodejs\\npm.cmd", ["install", "-g", "@openai/codex@1.2.3"])).toEqual({
      cmd: '"C:\\Program Files\\nodejs\\npm.cmd"',
      args: ["install", "-g", "@openai/codex@1.2.3"],
      shell: true,
    });
    for (const bad of ["x & calc", "a|b", "%PATH%", 'a"b', "a>b", "a^b", "a\nb"])
      expect(() => viaShell("win32", "C:\\n\\npm.cmd", ["install", bad])).toThrow();
  });
});
