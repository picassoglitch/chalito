/**
 * The driver hook (engine contract §3): each recipe kind's driver registers a factory here and
 * the engine's executor (`app.*`, `session.start {appId}`) looks it up by kind. Minimal on
 * purpose: the ENGINE builder owns the daemon integration and may extend this file; other
 * builders only call `registerDriver(kind, factory)`.
 */

/** Recipe kinds (packages/protocol recipe.ts `kinds`). */
export type DriverKind = "claude-sdk" | "codex" | "acp" | "terminal" | "desktop-app" | "web-app";

/** What every factory gets from the daemon. */
export interface DriverContext {
  /** The person's home directory (managed browser profiles live under ~/.chalito/browsers). */
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

/**
 * The part of a recipe (packages/protocol recipe.ts, owned by the engine) the app drivers read.
 * Structural, so the engine's `Recipe` type fits as is.
 */
export interface LaunchableRecipe {
  id: string;
  name: string;
  kinds: readonly string[];
  platforms: Partial<
    Record<
      "mac" | "windows" | "linux",
      {
        detect?: {
          commands?: readonly string[];
          paths?: readonly string[];
          bundleIds?: readonly string[];
          appUserModelIds?: readonly string[];
        };
        launch?: { command?: readonly string[]; app?: string };
      }
    >
  >;
  driver: {
    web?: { startUrl: string; allowedOrigins: readonly string[] };
    desktopApp?: { bundleId?: string; exe?: string };
  };
}

export type AppLaunchFailure =
  "not_installed" | "no_browser" | "origin_not_allowed" | "unsupported_platform" | "bad_recipe" | "launch_failed";

export type AppLaunchResult = { ok: true; detail?: string } | { ok: false; reason: AppLaunchFailure };

/** The `web-app` and `desktop-app` drivers: open (or bring forward) the app on this computer. */
export interface AppLaunchDriver {
  launch(recipe: LaunchableRecipe, opts?: { url?: string }): Promise<AppLaunchResult>;
}

/** What each kind's factory returns; kinds other builders own stay `unknown` here. */
export type DriverOf<K extends DriverKind> = K extends "web-app" | "desktop-app" ? AppLaunchDriver : unknown;

export type DriverFactory<K extends DriverKind = DriverKind> = (ctx: DriverContext) => DriverOf<K>;

const factories = new Map<DriverKind, DriverFactory>();

/** Registers (or replaces) the factory for a recipe kind. */
export const registerDriver = <K extends DriverKind>(kind: K, factory: DriverFactory<K>): void => {
  factories.set(kind, factory as DriverFactory);
};

/** The factory for a kind, if one is registered. */
export const driverFactory = <K extends DriverKind>(kind: K): DriverFactory<K> | undefined =>
  factories.get(kind) as DriverFactory<K> | undefined;

/** Kinds with a registered driver. */
export const registeredDriverKinds = (): DriverKind[] => [...factories.keys()];
