import { DesktopAppDriver, platformKey } from "./desktop-app.js";
import { systemLauncher, type Launcher } from "./launcher.js";
import {
  driverFactory,
  registerDriver,
  type AppLaunchResult,
  type DriverContext,
  type LaunchableRecipe,
} from "./registry.js";
import { WebAppDriver } from "./web-app.js";

/**
 * Registers the screen builder's two drivers behind the engine hook: `web-app` (managed browser
 * profile) and `desktop-app` (open / focus the app).
 */
export const registerAppDrivers = (launcher?: (ctx: DriverContext) => Launcher): void => {
  const l = (ctx: DriverContext) => launcher?.(ctx) ?? systemLauncher(ctx.env, ctx.platform);
  registerDriver("web-app", (ctx) => new WebAppDriver(ctx, l(ctx)));
  registerDriver("desktop-app", (ctx) => new DesktopAppDriver(ctx, l(ctx)));
};

export interface LaunchableApp {
  id: string;
  name: string;
  kind: "desktop-app" | "web-app";
}

/**
 * The person's launchable apps (curated + their own recipes, from the engine's catalog) and how
 * to open them: what `screen.open {appId}`, `app.launch` and the computer MCP's `launch_app` /
 * `open_web_app` use. Only recipes count: there is no way to launch an arbitrary program or URL.
 */
export class AppLauncher {
  constructor(
    private readonly d: {
      recipes: () => readonly LaunchableRecipe[];
      ctx: DriverContext;
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
    return factory(this.d.ctx).launch(r, opts?.url ? { url: opts.url } : undefined);
  }

  focusOrLaunch(appId: string): Promise<AppLaunchResult> {
    return this.launch(appId);
  }
}
