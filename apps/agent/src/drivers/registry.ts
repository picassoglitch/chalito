/**
 * Driver registry (Connect engine, contract v2 §3): each kind of recipe driver (`acp`,
 * `terminal`, `web`, `desktopApp`) registers one factory here, and the engine's daemon
 * integration asks for it when a recipe of that kind is used. Kept minimal on purpose: the
 * ENGINE builder owns the full integration and may extend this file.
 */

export type DriverKind = "acp" | "terminal" | "web" | "desktopApp";

/** The part of a recipe (packages/protocol recipe.ts) a driver needs: its id, name and driver specs. */
export interface DriverRecipe {
  id: string;
  name?: string;
  driver: Partial<Record<DriverKind, unknown>>;
}

/** Builds what a driver of that kind needs from one recipe; null when the recipe has no such driver. */
export type DriverFactory = (recipe: DriverRecipe) => unknown;

const factories = new Map<DriverKind, DriverFactory>();

/** Registers (or replaces) the factory for one driver kind. */
export const registerDriver = (kind: DriverKind, factory: DriverFactory): void => {
  factories.set(kind, factory);
};

/** The factory registered for that kind, if any. */
export const driverFactory = (kind: DriverKind): DriverFactory | undefined => factories.get(kind);
