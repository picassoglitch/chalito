import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Launcher } from "./launcher.js";
import type {
  AppDriverContext as DriverContext,
  AppLaunchDriver,
  AppLaunchResult,
  LaunchableRecipe,
} from "./app-launch.js";

/**
 * Managed AI websites (`web-app` recipes): the system's own Chrome, Edge or Chromium, started
 * with a profile of its own per app under `~/.chalito/browsers/<appId>`. The person signs in on
 * the real website there, once; cookies and sessions stay in that profile on this computer and
 * Chalito never reads, copies or uploads them. Separate profiles keep apps apart from each other
 * and from the person's everyday browser.
 *
 * Origin allowlist: Chalito only ever opens URLs whose origin the recipe lists
 * (`driver.web.allowedOrigins`), and opens them in app mode (no address bar). Links the person
 * follows inside that window are theirs to follow: the browser itself isn't locked to those
 * origins (Chrome has no per-profile URL allowlist without machine-wide enterprise policy).
 */

export const RECIPE_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** `~/.chalito/browsers/<appId>`, refusing anything that isn't a recipe id or would leave that folder. */
export const browserProfileDir = (home: string, appId: string): string => {
  if (!RECIPE_ID.test(appId)) throw new Error("bad app id");
  const base = resolve(home, ".chalito", "browsers");
  const dir = resolve(base, appId);
  if (!dir.startsWith(base + sep)) throw new Error("bad app id");
  return dir;
};

/** The https origin of a URL, or null (http is accepted only for localhost apps like LM Studio). */
export const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    if (u.protocol === "https:") return u.origin;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u.origin;
    return null;
  } catch {
    return null;
  }
};

/** Whether the recipe allows Chalito to open this URL. */
export const urlAllowed = (recipe: LaunchableRecipe, url: string): boolean => {
  const origin = originOf(url);
  const allowed = recipe.driver.web?.allowedOrigins ?? [];
  return !!origin && allowed.some((o) => originOf(o) === origin);
};

export interface BrowserCandidate {
  name: "chrome" | "edge" | "chromium";
  /** Absolute path, or a command name looked up on PATH (Linux). */
  path: string;
}

/** Where Chrome, Edge and Chromium live, in order of preference. */
export const browserCandidates = (
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): BrowserCandidate[] => {
  switch (platform) {
    case "darwin":
      return [
        { name: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
        { name: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
        { name: "chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
        ...(env.HOME
          ? [
              {
                name: "chrome" as const,
                path: join(env.HOME, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
              },
            ]
          : []),
      ];
    case "win32": {
      const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
      const win = (r: string, ...p: string[]) => [r, ...p].join("\\");
      return [
        ...roots.map((r) => ({
          name: "chrome" as const,
          path: win(r, "Google", "Chrome", "Application", "chrome.exe"),
        })),
        ...roots.map((r) => ({
          name: "edge" as const,
          path: win(r, "Microsoft", "Edge", "Application", "msedge.exe"),
        })),
        ...roots.map((r) => ({ name: "chromium" as const, path: win(r, "Chromium", "Application", "chrome.exe") })),
      ];
    }
    case "linux":
      return [
        { name: "chrome", path: "google-chrome-stable" },
        { name: "chrome", path: "google-chrome" },
        { name: "edge", path: "microsoft-edge-stable" },
        { name: "edge", path: "microsoft-edge" },
        { name: "chromium", path: "chromium" },
        { name: "chromium", path: "chromium-browser" },
      ];
    default:
      return [];
  }
};

export const findBrowser = (
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  launcher: Pick<Launcher, "exists" | "which">,
): { name: BrowserCandidate["name"]; path: string } | null => {
  for (const c of browserCandidates(platform, env)) {
    if (c.path.includes("/") || c.path.includes("\\")) {
      if (launcher.exists(c.path)) return c;
    } else {
      const p = launcher.which(c.path);
      if (p) return { name: c.name, path: p };
    }
  }
  return null;
};

/** The arguments: its own profile, no first-run prompts, the URL in an app window. */
export const browserArgs = (profileDir: string, url: string): string[] => [
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  `--app=${url}`,
];

export class WebAppDriver implements AppLaunchDriver {
  constructor(
    private readonly ctx: DriverContext,
    private readonly launcher: Launcher,
    private readonly mkdir: (dir: string) => void = (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
  ) {}

  async launch(recipe: LaunchableRecipe, opts?: { url?: string }): Promise<AppLaunchResult> {
    const web = recipe.driver.web;
    if (!web || !RECIPE_ID.test(recipe.id)) return { ok: false, reason: "bad_recipe" };
    // The recipe's own start page must be on its allowlist too.
    if (!urlAllowed(recipe, web.startUrl)) return { ok: false, reason: "bad_recipe" };
    const url = opts?.url ?? web.startUrl;
    if (!urlAllowed(recipe, url)) return { ok: false, reason: "origin_not_allowed" };
    const browser = findBrowser(this.ctx.platform, this.ctx.env, this.launcher);
    if (!browser) return { ok: false, reason: "no_browser" };
    const dir = browserProfileDir(this.ctx.home, recipe.id);
    this.mkdir(resolve(this.ctx.home, ".chalito", "browsers"));
    this.mkdir(dir);
    const r = await this.launcher.spawnDetached(browser.path, browserArgs(dir, url));
    return r.ok ? { ok: true, detail: browser.name } : { ok: false, reason: "launch_failed" };
  }
}
