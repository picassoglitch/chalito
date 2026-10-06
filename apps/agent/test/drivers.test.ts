import { describe, expect, it } from "vitest";
import { AppLauncher, registerAppDrivers } from "../src/drivers/apps.js";
import { DesktopAppDriver, desktopLaunchCommand } from "../src/drivers/desktop-app.js";
import type { Launcher } from "../src/drivers/launcher.js";
import {
  driverFactory,
  registerDriver,
  registeredDriverKinds,
  type LaunchableRecipe,
} from "../src/drivers/registry.js";
import {
  WebAppDriver,
  browserArgs,
  browserProfileDir,
  findBrowser,
  originOf,
  urlAllowed,
} from "../src/drivers/web-app.js";

/** A launcher that records instead of starting anything. */
const fakeLauncher = (o: { files?: string[]; path?: Record<string, string>; fail?: boolean } = {}) => {
  const spawned: { cmd: string; args: string[] }[] = [];
  const launcher: Launcher = {
    spawnDetached: async (cmd, args) => {
      spawned.push({ cmd, args });
      return { ok: !o.fail };
    },
    exists: (p) => (o.files ?? []).includes(p),
    which: (n) => o.path?.[n] ?? null,
  };
  return { launcher, spawned };
};

const chatgpt: LaunchableRecipe = {
  id: "chatgpt",
  name: "ChatGPT",
  kinds: ["web-app"],
  platforms: {},
  driver: {
    web: { startUrl: "https://chatgpt.com/", allowedOrigins: ["https://chatgpt.com", "https://auth.openai.com"] },
  },
};

const claudeDesktop: LaunchableRecipe = {
  id: "claude-desktop",
  name: "Claude",
  kinds: ["desktop-app"],
  platforms: {
    mac: { detect: { bundleIds: ["com.anthropic.claudefordesktop"] }, launch: { app: "Claude" } },
    windows: { detect: { appUserModelIds: ["AnthropicPBC.Claude_pzs8sxrjxfjjc!Claude"] } },
  },
  driver: { desktopApp: { bundleId: "com.anthropic.claudefordesktop" } },
};

const lmStudio: LaunchableRecipe = {
  id: "lm-studio",
  name: "LM Studio",
  kinds: ["desktop-app"],
  platforms: { linux: { detect: { commands: ["lm-studio"] }, launch: { command: ["lm-studio", "--minimized"] } } },
  driver: {},
};

const HOME = "/home/aldo";
const linux = { home: HOME, platform: "linux" as const, env: { PATH: "/usr/bin" } };

describe("managed browser profiles (web-app)", () => {
  it("one profile per app under ~/.chalito/browsers, never outside it", () => {
    expect(browserProfileDir(HOME, "chatgpt")).toBe("/home/aldo/.chalito/browsers/chatgpt");
    for (const bad of ["../x", "..", "a/b", "ChatGPT", "x", "-flag", "a".repeat(50), "chatgpt\0"])
      expect(() => browserProfileDir(HOME, bad)).toThrow();
  });

  it("opens only https URLs on the recipe's allowed origins (localhost http for local apps)", () => {
    expect(originOf("https://chatgpt.com/c/123?q=1")).toBe("https://chatgpt.com");
    expect(originOf("http://chatgpt.com/")).toBeNull();
    expect(originOf("https://user:pw@chatgpt.com/")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("http://localhost:1234/")).toBe("http://localhost:1234");
    expect(urlAllowed(chatgpt, "https://chatgpt.com/g/abc")).toBe(true);
    expect(urlAllowed(chatgpt, "https://auth.openai.com/log-in")).toBe(true);
    expect(urlAllowed(chatgpt, "https://chatgpt.com.evil.example/")).toBe(false);
    expect(urlAllowed(chatgpt, "https://evil.example/?u=https://chatgpt.com")).toBe(false);
  });

  it("finds Chrome, Edge or Chromium per platform", () => {
    expect(findBrowser("linux", {}, fakeLauncher({ path: { chromium: "/usr/bin/chromium" } }).launcher)).toEqual({
      name: "chromium",
      path: "/usr/bin/chromium",
    });
    const mac = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    expect(findBrowser("darwin", {}, fakeLauncher({ files: [mac] }).launcher)).toEqual({ name: "edge", path: mac });
    const win = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    expect(
      findBrowser("win32", { PROGRAMFILES: "C:\\Program Files" }, fakeLauncher({ files: [win] }).launcher),
    ).toEqual({ name: "chrome", path: win });
    expect(findBrowser("linux", {}, fakeLauncher().launcher)).toBeNull();
  });

  it("launches the browser with the app's own profile in an app window (launcher mocked)", async () => {
    const { launcher, spawned } = fakeLauncher({ path: { "google-chrome": "/usr/bin/google-chrome" } });
    const made: string[] = [];
    const d = new WebAppDriver(linux, launcher, (dir) => void made.push(dir));
    expect(await d.launch(chatgpt)).toEqual({ ok: true, detail: "chrome" });
    expect(spawned).toEqual([
      {
        cmd: "/usr/bin/google-chrome",
        args: browserArgs("/home/aldo/.chalito/browsers/chatgpt", "https://chatgpt.com/"),
      },
    ]);
    expect(spawned[0]!.args).toEqual([
      "--user-data-dir=/home/aldo/.chalito/browsers/chatgpt",
      "--no-first-run",
      "--no-default-browser-check",
      "--app=https://chatgpt.com/",
    ]);
    expect(made).toEqual(["/home/aldo/.chalito/browsers", "/home/aldo/.chalito/browsers/chatgpt"]);
    expect(await d.launch(chatgpt, { url: "https://chatgpt.com/c/1" })).toEqual({ ok: true, detail: "chrome" });
    expect(await d.launch(chatgpt, { url: "https://evil.example/" })).toEqual({
      ok: false,
      reason: "origin_not_allowed",
    });
    expect(spawned).toHaveLength(2);
  });

  it("refuses recipes whose start page isn't on their own allowlist, and reports a missing browser", async () => {
    const { launcher, spawned } = fakeLauncher({ path: { chromium: "/usr/bin/chromium" } });
    const d = new WebAppDriver(linux, launcher, () => undefined);
    const bad = {
      ...chatgpt,
      driver: { web: { startUrl: "https://evil.example/", allowedOrigins: ["https://chatgpt.com"] } },
    };
    expect(await d.launch(bad)).toEqual({ ok: false, reason: "bad_recipe" });
    expect(await d.launch({ ...chatgpt, id: "../../x" })).toEqual({ ok: false, reason: "bad_recipe" });
    expect(spawned).toEqual([]);
    const none = new WebAppDriver(linux, fakeLauncher().launcher, () => undefined);
    expect(await none.launch(chatgpt)).toEqual({ ok: false, reason: "no_browser" });
  });
});

describe("desktop apps", () => {
  it("opens or focuses the app with a fixed command per OS, never a shell", () => {
    const l = fakeLauncher({ path: { "lm-studio": "/opt/lm/lm-studio" } }).launcher;
    expect(desktopLaunchCommand(claudeDesktop, { platform: "darwin", env: {} }, l)).toEqual({
      cmd: "/usr/bin/open",
      args: ["-a", "Claude"],
    });
    expect(desktopLaunchCommand(claudeDesktop, { platform: "win32", env: { SYSTEMROOT: "C:\\Windows" } }, l)).toEqual({
      cmd: "C:\\Windows\\explorer.exe",
      args: ["shell:AppsFolder\\AnthropicPBC.Claude_pzs8sxrjxfjjc!Claude"],
    });
    expect(desktopLaunchCommand(lmStudio, { platform: "linux", env: {} }, l)).toEqual({
      cmd: "/opt/lm/lm-studio",
      args: ["--minimized"],
    });
    expect(desktopLaunchCommand(claudeDesktop, { platform: "linux", env: {} }, l)).toEqual({
      error: "unsupported_platform",
    });
    expect(desktopLaunchCommand(lmStudio, { platform: "linux", env: {} }, fakeLauncher().launcher)).toEqual({
      error: "not_installed",
    });
    const sneaky: LaunchableRecipe = { ...claudeDesktop, platforms: { mac: { launch: { app: "-n /bin/sh" } } } };
    expect(desktopLaunchCommand(sneaky, { platform: "darwin", env: {} }, l)).toEqual({ error: "bad_recipe" });
  });

  it("launches through the launcher (mocked)", async () => {
    const { launcher, spawned } = fakeLauncher();
    const d = new DesktopAppDriver({ home: HOME, platform: "darwin", env: {} }, launcher);
    expect(await d.launch(claudeDesktop)).toEqual({ ok: true });
    expect(spawned).toEqual([{ cmd: "/usr/bin/open", args: ["-a", "Claude"] }]);
  });
});

describe("the driver hook and the person's launchable apps", () => {
  it("registers web-app and desktop-app factories behind registerDriver", () => {
    registerAppDrivers(() => fakeLauncher().launcher);
    expect(registeredDriverKinds()).toEqual(expect.arrayContaining(["web-app", "desktop-app"]));
    expect(driverFactory("web-app")).toBeTypeOf("function");
    registerDriver("terminal", () => ({ custom: true }));
    expect(driverFactory("terminal")!({ home: HOME, platform: "linux", env: {} })).toEqual({ custom: true });
  });

  it("lists and launches only recipes, picking the desktop app or the managed browser", async () => {
    const { launcher, spawned } = fakeLauncher({
      files: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    });
    registerAppDrivers(() => launcher);
    const apps = new AppLauncher({
      recipes: () => [chatgpt, claudeDesktop, lmStudio],
      ctx: { home: HOME, platform: "darwin", env: {} },
    });
    expect(apps.list()).toEqual([
      { id: "chatgpt", name: "ChatGPT", kind: "web-app" },
      { id: "claude-desktop", name: "Claude", kind: "desktop-app" },
    ]);
    expect(apps.has("lm-studio")).toBe(false);
    expect(apps.has("chatgpt", "desktop-app")).toBe(false);
    expect(await apps.launch("claude-desktop")).toEqual({ ok: true });
    expect(await apps.launch("unknown-app")).toEqual({ ok: false, reason: "bad_recipe" });
    // A URL only goes to a web-app's managed profile.
    expect(await apps.launch("claude-desktop", { url: "https://claude.ai/" })).toEqual({
      ok: false,
      reason: "origin_not_allowed",
    });
    expect(spawned.map((s) => s.cmd)).toEqual(["/usr/bin/open"]);
  });
});
