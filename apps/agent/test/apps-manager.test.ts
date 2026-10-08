import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConnectionDoc, Recipe } from "@chalito/protocol";
import type { ClaudePin } from "../src/claude-pin.js";
import { BUILTIN_CATALOG, type CatalogEntry } from "../src/apps/catalog.js";
import { AppManager, appSecretName, expandPath } from "../src/apps/manager.js";
import { createLogger } from "../src/redact.js";
import { MemorySecretStore } from "../src/secrets.js";
import { fakeProviderProcs, type ProcCall } from "./fake-provider-procs.js";

/** The connect engine's executor on recipes beyond the four former providers, with faked CLIs. */

const NOW = 1_790_000_000_000;
const exe = (dir: string, name: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n# ${name}\n`);
  chmodSync(p, 0o755);
  return p;
};
const curated = (id: string): CatalogEntry => ({
  recipe: BUILTIN_CATALOG.recipes.find((r) => r.id === id)!,
  custom: false,
  enabled: true,
});

const custom = Recipe.parse({
  v: 1,
  id: "mi-agente",
  name: "Mi agente",
  vendor: "Yo",
  homepage: "https://example.com",
  termsUrl: "https://example.com/terms",
  kinds: ["acp", "terminal"],
  platforms: { linux: { detect: { commands: ["miagente"] }, install: { via: "npm", ref: "mi-agente" } } },
  signin: {
    via: "cli",
    command: ["miagente", "login"],
    statusCommand: ["miagente", "whoami"],
    logoutCommand: ["miagente", "logout"],
    planSignin: "on",
  },
  apiKey: { env: "MI_KEY", label: "Mi key", docsUrl: "https://example.com/keys" },
  driver: { acp: { command: ["miagente", "acp"] }, terminal: { command: ["miagente"] } },
  profile: { env: { MIAGENTE_HOME: "{chalito}/miagente" } },
  capabilities: ["sessions", "terminal"],
});

const setup = (
  o: {
    platform?: NodeJS.Platform;
    installed?: string[];
    tools?: string[];
    entries?: CatalogEntry[];
    customEnabled?: boolean;
    answer?: Parameters<typeof fakeProviderProcs>[0];
    env?: Record<string, string>;
    launcher?: (id: string) => (() => Promise<boolean>) | undefined;
  } = {},
) => {
  const home = mkdtempSync(join(tmpdir(), "chalito-apps-"));
  const dir = join(home, ".chalito");
  const bin = join(home, "bin");
  mkdirSync(dir, { recursive: true });
  mkdirSync(bin);
  for (const b of [...(o.installed ?? []), ...(o.tools ?? [])]) exe(bin, b);
  const fake = fakeProviderProcs((c) => o.answer?.(c) ?? {});
  const secrets = new MemorySecretStore();
  const pins = new Map<string, ClaudePin>();
  const reports: [string, AppConnectionDoc][] = [];
  const logs: string[] = [];
  let changes = 0;
  const entries = o.entries ?? [
    curated("goose"),
    curated("chatgpt"),
    curated("cursor"),
    curated("chatgpt-desktop"),
    curated("aider"),
    { recipe: custom, custom: true, enabled: o.customEnabled ?? false },
  ];
  const m = new AppManager({
    dir,
    env: { PATH: bin, HOME: home, ...o.env },
    platform: o.platform ?? "linux",
    secrets,
    procs: fake.procs,
    entries: () => entries,
    signinAllowed: (e) => e.recipe.signin.planSignin === "on",
    pins: { get: (a) => pins.get(a), set: async (a, pin) => void pins.set(a, pin) },
    report: async (a, doc) => void reports.push([a, AppConnectionDoc.parse(doc)]),
    onChange: () => void changes++,
    ...(o.launcher ? { launcher: o.launcher } : {}),
    now: () => NOW,
    log: createLogger((l) => logs.push(l)),
  });
  const last = (a: string) => reports.filter(([q]) => q === a).at(-1)?.[1];
  return { m, home, dir, bin, fake, secrets, pins, reports, logs, last, changes: () => changes };
};
const cmd = (c: ProcCall) => `${c.cmd.split("/").pop()} ${c.args.join(" ")}`;

describe("AppManager: status for any kind of app", () => {
  it("reports every app with its kind; web apps are available; a missing OS entry is unsupported_platform", async () => {
    const s = setup({ installed: ["goose"], platform: "linux" });
    await s.m.report();
    expect(s.reports.map(([a]) => a)).toEqual(["goose", "chatgpt", "cursor", "chatgpt-desktop", "aider", "mi-agente"]);
    expect(s.last("goose")).toMatchObject({ kind: "acp", custom: false, cli: { installed: true, version: "1.2.3" } });
    expect(s.last("chatgpt")).toMatchObject({ kind: "web-app", state: "available", cli: { installed: true } });
    expect(s.last("chatgpt-desktop")).toMatchObject({ state: "not_installed", error: "unsupported_platform" });
    expect(s.last("cursor")).toMatchObject({ kind: "desktop-app", state: "not_installed" });
    expect(s.last("mi-agente")).toEqual({
      mode: null,
      connected: false,
      state: "error",
      cli: { installed: false, version: null },
      error: "recipe_disabled",
      at: NOW,
      kind: "acp",
      custom: true,
      name: "Mi agente",
    });
    // Only a custom recipe's own name leaves the computer.
    expect(s.reports.filter(([, d]) => d.name !== undefined).map(([a]) => a)).toEqual(["mi-agente"]);
  });

  it("a desktop app is found by its install path even without its shell command, and is then available", async () => {
    const s = setup({ platform: "darwin" });
    expect((await s.m.status("chatgpt-desktop"))?.state).toBe("not_installed");
    expect(s.fake.calls.map(cmd)).toContain("mdfind kMDItemCFBundleIdentifier == 'com.openai.codex'");
    const cursorWin = setup({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } });
    expect(expandPath("%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe", { LOCALAPPDATA: "C:\\L" })).toBe(
      "C:\\L\\Programs\\cursor\\Cursor.exe",
    );
    expect(expandPath("~/x", { HOME: "/home/me" })).toBe("/home/me/x");
    expect(expandPath("%APPDATA%\\x", {})).toBeNull();
    expect((await cursorWin.m.status("cursor"))?.state).toBe("not_installed");

    const mac = setup({
      platform: "darwin",
      answer: (c) =>
        c.cmd === "mdfind" && c.args[0]!.includes("com.openai.codex") ? { stdout: "/Applications/ChatGPT.app\n" } : {},
    });
    expect(await mac.m.status("chatgpt-desktop")).toMatchObject({ state: "available", cli: { installed: true } });
  });

  it("a CLI whose sign-in only works in its own terminal UI is available once installed, and never run headless", async () => {
    const s = setup({ installed: ["aider"] });
    expect((await s.m.status("aider"))?.state).toBe("needs_auth"); // it takes an API key
    expect(await s.m.signin("aider")).toEqual({ ok: false, reason: "app_unavailable" });
    expect(s.fake.calls.some((c) => c.cmd.endsWith("aider") && c.args[0] !== "--version")).toBe(false);
    const g = setup({ installed: ["goose"] });
    expect((await g.m.status("goose"))?.state).toBe("available");
  });
});

describe("AppManager: custom recipes run only once enabled on this computer", () => {
  it("a disabled one is reported but nothing of it runs, and every action is refused", async () => {
    const s = setup({ installed: ["miagente"], tools: ["npm"] });
    await s.m.status("mi-agente");
    for (const r of [
      await s.m.signin("mi-agente"),
      await s.m.connectKey("mi-agente", "k-123"),
      await s.m.requestInstall("mi-agente"),
      await s.m.install("mi-agente"),
      await s.m.launch("mi-agente"),
    ])
      expect(r).toEqual({ ok: false, reason: "recipe_disabled" });
    expect(s.fake.calls).toEqual([]);
    expect(s.fake.launched).toEqual([]);
    expect(await s.secrets.get(appSecretName("mi-agente"))).toBeNull();
  });

  it("once enabled: its own sign-in in its Chalito profile, confirmed by its status command", async () => {
    let signedIn = false;
    const s = setup({
      installed: ["miagente"],
      customEnabled: true,
      answer: (c) => {
        if (c.args.join(" ") === "login") signedIn = true;
        if (c.args.join(" ") === "whoami") return { code: signedIn ? 0 : 1 };
        return {};
      },
    });
    expect(await s.m.signin("mi-agente")).toEqual({ ok: true });
    await s.m.signingIn;
    const login = s.fake.calls.find((c) => c.args[0] === "login")!;
    expect(cmd(login)).toBe("miagente login");
    expect(login.env.MIAGENTE_HOME).toBe(join(s.dir, "miagente"));
    expect(s.last("mi-agente")).toMatchObject({ mode: "signin", state: "connected", custom: true });
    expect(s.pins.get("mi-agente")?.path).toBe(join(s.bin, "miagente"));
    await s.m.disconnect("mi-agente");
    expect(s.fake.calls.map(cmd)).toContain("miagente logout");
  });

  it("an API key lands in the app's own keychain slot; an app without apiKey refuses one", async () => {
    const s = setup({ installed: ["miagente"], customEnabled: true });
    expect(await s.m.connectKey("mi-agente", "k-123")).toEqual({ ok: true });
    expect(await s.secrets.get("byo-app-mi-agente-api-key")).toBe("k-123");
    expect(JSON.stringify([s.reports, s.logs])).not.toContain("k-123");
    expect(await s.m.connectKey("chatgpt", "sk-x")).toEqual({ ok: false, reason: "app_unavailable" });
    expect(await s.m.connectKey("nope", "x")).toEqual({ ok: false, reason: "unknown_app" });
  });
});

describe("AppManager: official installs only", () => {
  it("brew casks and winget (incl. the Microsoft Store source) run after the local yes", async () => {
    const mac = setup({ platform: "darwin", tools: ["brew"] });
    expect(await mac.m.requestInstall("chatgpt-desktop")).toEqual({ ok: true });
    expect(mac.fake.calls.some((c) => c.args[0] === "install")).toBe(false);
    expect(await mac.m.install("chatgpt-desktop")).toEqual({ ok: true });
    await mac.m.installing;
    expect(mac.fake.calls.map(cmd)).toContain("brew install --cask chatgpt");

    const win = setup({ platform: "win32", tools: ["winget.EXE"], env: { PATHEXT: ".EXE" } });
    expect(await win.m.install("chatgpt-desktop")).toEqual({ ok: true });
    await win.m.installing;
    expect(win.fake.calls.map(cmd).find((c) => c.startsWith("winget"))).toBe(
      "winget.EXE install --id 9PLM9XGG6VKS --exact --source msstore --accept-package-agreements --accept-source-agreements --disable-interactivity",
    );
  });

  it("an installer that fails to spawn leaves the app usable again (not stuck installing)", async () => {
    const mac = setup({
      platform: "darwin",
      tools: ["brew"],
      answer: (c) => {
        if (c.args[0] === "install") throw new Error("spawn EACCES");
        return {};
      },
    });
    expect(await mac.m.install("chatgpt-desktop")).toEqual({ ok: true });
    await expect(mac.m.installing).resolves.toBeUndefined();
    expect(mac.last("chatgpt-desktop")).toMatchObject({ error: "install_failed" });
    // Not provider_busy: the next try runs.
    expect(await mac.m.install("chatgpt-desktop")).toEqual({ ok: true });
    await mac.m.installing;
  });

  it("an official-url install only opens the vendor's page; a missing tool is an error code", async () => {
    const s = setup({ platform: "linux" });
    expect(await s.m.install("aider")).toEqual({ ok: true });
    expect(s.fake.opened).toEqual(["https://aider.chat/docs/install.html"]);
    expect(s.fake.calls).toEqual([]);
    const mac = setup({ platform: "darwin" });
    expect(await mac.m.install("cursor")).toEqual({ ok: false, reason: "provider_failed" });
    expect(mac.last("cursor")).toMatchObject({ error: "install_unavailable" });
    expect(await s.m.install("chatgpt")).toEqual({ ok: false, reason: "app_unavailable" });
  });
});

describe("AppManager: launch", () => {
  it("a web app opens its start page; a registered driver's launcher (managed profile) wins", async () => {
    const s = setup();
    expect(await s.m.launch("chatgpt")).toEqual({ ok: true });
    expect(s.fake.opened).toEqual(["https://chatgpt.com/"]);
    const launched: string[] = [];
    const d = setup({ launcher: (id) => (id === "chatgpt" ? async () => (launched.push(id), true) : undefined) });
    expect(await d.m.launch("chatgpt")).toEqual({ ok: true });
    expect(launched).toEqual(["chatgpt"]);
    expect(d.fake.opened).toEqual([]);
  });

  it("a desktop app opens the OS way (open -a / Start menu entry), detached; a failure is launch_failed", async () => {
    const mac = setup({ platform: "darwin" });
    expect(await mac.m.launch("chatgpt-desktop")).toEqual({ ok: true });
    expect(mac.fake.launched.map(cmd)).toEqual(["open -a ChatGPT"]);
    mac.fake.launchResult.ok = false;
    expect(await mac.m.launch("chatgpt-desktop")).toEqual({ ok: false, reason: "app_unavailable" });
    expect((await mac.m.status("chatgpt-desktop"))?.error).toBe("launch_failed");
  });

  it("a desktop app's sign-in is just opening it: the person signs in there", async () => {
    const mac = setup({ platform: "darwin" });
    expect(await mac.m.signin("chatgpt-desktop")).toEqual({ ok: true });
    expect(mac.fake.launched.map(cmd)).toEqual(["open -a ChatGPT"]);
    const web = setup();
    expect(await web.m.signin("chatgpt")).toEqual({ ok: true });
    expect(web.fake.opened).toEqual(["https://chatgpt.com/"]);
  });
});
