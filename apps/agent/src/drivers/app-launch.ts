/**
 * Launching an app on this computer (remote screen builder): the `web-app` driver (a managed
 * browser profile) and the `desktop-app` driver (open / focus the app). They plug into the
 * engine's one registry (drivers/registry.ts) as the `app` part of a Driver.
 */

/** What the app drivers need from the daemon. */
export interface AppDriverContext {
  /** The person's home directory (managed browser profiles live under ~/.chalito/browsers). */
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

/**
 * The part of a recipe (packages/protocol recipe.ts) the app drivers read. Structural, so the
 * engine's `Recipe` fits as is.
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
