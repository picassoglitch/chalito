import { AcpAdapter, type AcpRecipe } from "@chalito/adapters/acp";
import type { Logger } from "../redact.js";
import { type DriverFactory, registerDriver } from "./registry.js";

/** What the ACP driver needs to start one app's ACP server (the engine's DriverContext, narrowed). */
export interface AcpDriverOptions {
  readonly recipe: AcpRecipe;
  /** The pinned (else detected) CLI; a driver never looks it up on PATH. */
  readonly binPath?: string | null;
  /** BYO API key from the OS keychain; wins over sign-in. */
  readonly apiKey?: string;
  /** The app's own sign-in on this computer, where the recipe's `planSignin` allows it. */
  readonly signIn?: boolean;
  /** Chalito's own state dir for the app. */
  readonly home: string;
  /** Base environment; the adapter passes only an allowlist of it on. */
  readonly env: Record<string, string | undefined>;
  readonly log: Logger;
}

/**
 * The ACP driver: any recipe with `driver.acp` (Grok Build, Gemini CLI, Goose, OpenCode, Qwen
 * Code, …) runs on the one ACP adapter. Throws for a recipe that can't run safely (no ACP driver,
 * a flag that skips approvals, a key variable that isn't a key; D-065).
 */
export const acpDriver = (o: AcpDriverOptions): AcpAdapter => {
  // Only the pinned CLI runs, never whatever `command[0]` finds on PATH.
  if (!o.binPath) throw new Error(`${o.recipe.name} isn't pinned on this computer`);
  return new AcpAdapter(
    { ...o.recipe, driver: { acp: o.recipe.driver.acp } },
    {
      binPath: o.binPath,
      ...(o.apiKey ? { apiKey: o.apiKey } : { signIn: o.signIn ?? false }),
      home: o.home,
      env: o.env,
    },
  );
};

/**
 * The engine's `acp` factory (drivers/registry.ts): a session adapter for `session.start {appId}`
 * of any recipe with `driver.acp`, built from what the person set up on this computer. Null when
 * the recipe has no ACP driver or its CLI isn't there; an unsafe recipe throws (logged, skipped).
 */
export const acpDriverFactory: DriverFactory = (ctx) => {
  if (!ctx.recipe.driver.acp || !ctx.bin) return null;
  return {
    adapter: acpDriver({
      recipe: ctx.recipe,
      binPath: ctx.bin,
      ...(ctx.auth.apiKey ? { apiKey: ctx.auth.apiKey } : { signIn: ctx.auth.signIn }),
      home: ctx.home,
      env: ctx.env,
      log: ctx.log,
    }),
  };
};

registerDriver("acp", acpDriverFactory);
