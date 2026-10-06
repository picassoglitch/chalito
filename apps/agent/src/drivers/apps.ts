import { homedir } from "node:os";
import { join } from "node:path";
import type { Recipe } from "@chalito/protocol";
import { createLogger, type Logger } from "../redact.js";
import type { AppDriverContext, AppLaunchDriver, AppLaunchResult, LaunchableRecipe } from "./app-launch.js";
import { DesktopAppDriver, platformKey } from "./desktop-app.js";
import { systemLauncher, type Launcher } from "./launcher.js";
import { driverFactory, registerDriver, type Driver, type DriverContext } from "./registry.js";
import { WebAppDriver } from "./web-app.js";

/** One app driver as the engine sees it: `app` for remote screen / the MCP, `launch` for `app.launch`. */
const asDriver = (app: AppLaunchDriver, recipe: LaunchableRecipe): Driver => ({
  app,
  launch: async () => (await app.launch(recipe).catch(() => ({ ok: false }) as const)).ok,
});

/**
 * Registers the screen builder's two drivers behind the engine hook (drivers/registry.ts):
 * `web-app` (managed browser profile under `home`/.chalito/browsers) and `desktop-app` (open /
 * focus the app). Returns a function that removes them again (tests).
 */
export const registerAppDrivers = (
  launcher?: (ctx: AppDriverContext) => Launcher,
  home: string = homedir(),
): (() => void) => {
  const appCtx = (ctx: DriverContext): AppDriverContext => ({ home, platform: ctx.platform, env: ctx.env });
  const l = (ctx: AppDriverContext) => launcher?.(ctx) ?? systemLauncher(ctx.env, ctx.platform);
  const offWeb = registerDriver("web-app", (ctx) => {
    const c = appCtx(ctx);
    return asDriver(new WebAppDriver(c, l(c)), ctx.recipe);
  });
  const offDesktop = registerDriver("desktop-app", (ctx) => {
    const c = appCtx(ctx);
    return asDriver(new DesktopAppDriver(c, l(c)), ctx.recipe);
  });
  return () => {
    offWeb();
    offDesktop();
  };
};

export interface LaunchableApp {
  id: string;
  name: string;
  kind: "desktop-app" | "web-app";
}

/**
 * The person's launchable apps (curated + their own enabled recipes, from the engine's catalog)
 * and how to open them: what `screen.open {appId}` and the computer MCP's `launch_app` /
 * `open_web_app` use (`app.launch` goes through the same registered drivers). Only recipes
 * count: there is no way to launch an arbitrary program or URL.
 */
export class AppLauncher {
  constructor(
    private readonly d: {
      recipes: () => readonly LaunchableRecipe[];
      ctx: AppDriverContext;
      log?: Logger;
    },
  ) {}

  #kinds(r: LaunchableRecipe): LaunchableApp["kind"][] {
    const key = platformKey(this.d.ctx.platform);
    const out: LaunchableApp["kind"][] = [];
    if (r.kinds.includes("desktop-app") && key && r.platforms[key]) out.push("desktop-app");
    if (r.kinds.includes("web-app") && r.driver.web) out.push("web-app");
    return out;
  }

  #recipe(appId: string): LaunchableRecipe | undefined {
    return this.d.recipes().find((r) => r.id === appId);
  }

  list(): LaunchableApp[] {
    return this.d.recipes().flatMap((r) => this.#kinds(r).map((kind) => ({ id: r.id, name: r.name, kind })));
  }

  has(appId: string, kind?: LaunchableApp["kind"]): boolean {
    const r = this.#recipe(appId);
    return !!r && this.#kinds(r).some((k) => !kind || k === kind);
  }

  /** Opens the app: its desktop app where the recipe has one here, else its managed browser profile. */
  async launch(appId: string, opts?: { kind?: LaunchableApp["kind"]; url?: string }): Promise<AppLaunchResult> {
    const r = this.#recipe(appId);
    if (!r) return { ok: false, reason: "bad_recipe" };
    const kinds = this.#kinds(r).filter((k) => !opts?.kind || k === opts.kind);
    // A URL only makes sense in the browser.
    const kind = opts?.url ? kinds.find((k) => k === "web-app") : kinds[0];
    if (!kind) return { ok: false, reason: opts?.url ? "origin_not_allowed" : "unsupported_platform" };
    const factory = driverFactory(kind);
    if (!factory) return { ok: false, reason: "unsupported_platform" };
    const chalito = join(this.d.ctx.home, ".chalito");
    const built = await factory({
      // The app drivers read only the LaunchableRecipe part (and take the recipe again in launch).
      recipe: r as unknown as Recipe,
      custom: false,
      bin: null,
      auth: { signIn: false },
      env: this.d.ctx.env,
      home: join(chalito, "apps", r.id),
      dir: chalito,
      platform: this.d.ctx.platform,
      log: this.d.log ?? createLogger(() => undefined),
    });
    if (!built?.app) return { ok: false, reason: "unsupported_platform" };
    return built.app.launch(r, opts?.url ? { url: opts.url } : undefined);
  }

  focusOrLaunch(appId: string): Promise<AppLaunchResult> {
    return this.launch(appId);
  }
}
