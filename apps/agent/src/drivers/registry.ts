import type { SessionAdapter } from "@chalito/adapters";
import type { Logger } from "../redact.js";

/**
 * Where app drivers plug into the daemon (engine contract §3): each driver kind of a recipe
 * (`driver.acp`, `driver.terminal`, …) registers one factory with `registerDriver(kind, factory)`,
 * and the daemon builds a recipe's driver with `driverFor(kind)`. Builders add their kind to
 * `DriverFactories` (here, or by declaration merging).
 */

/** A recipe as drivers see it; the engine's zod `Recipe` satisfies this. */
export interface DriverRecipe {
  readonly id: string;
  readonly name: string;
  readonly apiKey?: { readonly env: string } | undefined;
  readonly driver: {
    readonly acp?:
      { readonly command: readonly string[]; readonly authMethods?: readonly string[] | undefined } | undefined;
  };
}

export interface DriverContext {
  readonly recipe: DriverRecipe;
  /** The pinned CLI (resolved and checked by the daemon; a driver never looks it up on PATH). */
  readonly binPath?: string;
  /** BYO API key from the OS keychain; wins over sign-in. */
  readonly apiKey?: string;
  /** The app's own sign-in on this computer, where the recipe's `planSignin` allows it. */
  readonly signIn?: boolean;
  /** Chalito's own state dir for the app (~/.chalito/<recipe id>). */
  readonly home: string;
  /** Base environment; drivers pass only an allowlist of it on. */
  readonly env: Record<string, string | undefined>;
  readonly log: Logger;
}

export interface DriverFactories {
  /** Any agent that speaks the Agent Client Protocol (D-064). */
  acp: (ctx: DriverContext) => SessionAdapter;
}
export type DriverKind = keyof DriverFactories;

const factories = new Map<string, unknown>();

/** Registers the factory for a driver kind. A second, different factory for the same kind throws. */
export const registerDriver = <K extends DriverKind>(kind: K, factory: DriverFactories[K]): void => {
  const known = factories.get(kind);
  if (known && known !== factory) throw new Error(`driver "${kind}" is already registered`);
  factories.set(kind, factory);
};

/** The registered factory for a driver kind, if any. */
export const driverFor = <K extends DriverKind>(kind: K): DriverFactories[K] | undefined =>
  factories.get(kind) as DriverFactories[K] | undefined;
