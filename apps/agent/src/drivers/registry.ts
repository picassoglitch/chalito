import type { SessionAdapter } from "@chalito/adapters";
import type { Recipe, RecipeKind } from "@chalito/protocol";
import type { Logger } from "../redact.js";
import type { AppLaunchDriver } from "./app-launch.js";

/**
 * Driver hook (engine contract v2 §3): how the other builders plug a way of running an app into
 * the engine without touching daemon.ts. A factory is registered per recipe kind
 * (`registerDriver("acp", …)`, `registerDriver("terminal", …)`, `registerDriver("web-app", …)`),
 * and the daemon calls it for each app whose recipe has that kind, whenever what can run
 * changes (an app connected, installed, signed out, a custom recipe enabled).
 *
 * The context carries only what the person set up locally: the resolved binary (pinned or
 * detected, never a PATH lookup at run time), how the app is connected, and the app's own state
 * folder under ~/.chalito. A factory returns null when it can't drive this app.
 */
export interface DriverContext {
  recipe: Recipe;
  /** Whether the recipe is the person's own (`~/.chalito/recipes`, enabled on this computer). */
  custom: boolean;
  /** The app's CLI (argv[0] of its commands), resolved: pinned, else detected. Null without one. */
  bin: string | null;
  /** How the person connected it: a keychain API key, or the app's own sign-in (or neither). */
  auth: { apiKey?: string; signIn: boolean };
  /** The agent's environment plus the recipe's Chalito profile (`recipe.profile.env`). */
  env: Record<string, string | undefined>;
  /** ~/.chalito/apps/<appId>: a folder this app's driver may keep state in. */
  home: string;
  /** ~/.chalito */
  dir: string;
  platform: NodeJS.Platform;
  log: Logger;
}

export interface Driver {
  /** A session adapter for `session.start {appId}` (protocol drivers: acp, claude-sdk, codex). */
  adapter?: SessionAdapter;
  /**
   * Opens the app on this computer for `app.launch` (a desktop app's window, a web app's managed
   * browser profile). Resolves false when it couldn't.
   */
  launch?: () => Promise<boolean>;
  /** The `web-app` / `desktop-app` drivers (drivers/apps.ts): also used by remote screen and the computer MCP. */
  app?: AppLaunchDriver;
  /** Anything else a builder's driver exposes (terminal, screen) to its own command handlers. */
  [extension: string]: unknown;
}

export type DriverFactory = (ctx: DriverContext) => Driver | null | Promise<Driver | null>;

const factories = new Map<RecipeKind, DriverFactory>();

/**
 * Registers the factory for a recipe kind (one per kind; a later call replaces it). Returns a
 * function that removes it again, restoring the one it replaced (tests).
 */
export const registerDriver = (kind: RecipeKind, factory: DriverFactory): (() => void) => {
  const previous = factories.get(kind);
  factories.set(kind, factory);
  return () => {
    if (factories.get(kind) !== factory) return;
    if (previous) factories.set(kind, previous);
    else factories.delete(kind);
  };
};

/** The registered factory for a kind, if any. */
export const driverFactory = (kind: RecipeKind): DriverFactory | undefined => factories.get(kind);

/** Kinds with a registered factory. */
export const registeredDriverKinds = (): RecipeKind[] => [...factories.keys()];

/**
 * Builds the drivers of one app: every kind of its recipe with a registered factory, in the
 * recipe's order. A factory that throws is logged and skipped (one broken driver never stops the
 * others).
 */
export const buildDrivers = async (ctx: DriverContext): Promise<{ kind: RecipeKind; driver: Driver }[]> => {
  const out: { kind: RecipeKind; driver: Driver }[] = [];
  for (const kind of ctx.recipe.kinds) {
    const factory = factories.get(kind);
    if (!factory) continue;
    try {
      const driver = await factory(ctx);
      if (driver) out.push({ kind, driver });
    } catch (err) {
      ctx.log.warn("driver.build_failed", {
        appId: ctx.recipe.id,
        kind,
        error: err instanceof Error ? err.message : "error",
      });
    }
  }
  return out;
};

/** Alias of `driverFactory` (the name the ACP, terminal and screen builders used). */
export const driverFor = driverFactory;
