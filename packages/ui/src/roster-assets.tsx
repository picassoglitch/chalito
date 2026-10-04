import { createContext, useContext, type ReactNode } from "react";

/**
 * Where this shell serves @chalito/roster's files (the PWA copies them to /roster at build).
 * Without a provider the companion pictures fall back to a plain swatch.
 */
const RosterAssets = createContext<((path: string) => string) | null>(null);

export const RosterAssetsProvider = ({ base, children }: { base: string; children: ReactNode }) => (
  <RosterAssets.Provider value={(path) => `${base.replace(/\/+$/, "")}/${path}`}>{children}</RosterAssets.Provider>
);

/** A roster file's URL (e.g. `assets/luna/thumb-128.webp`), or null when this shell doesn't serve them. */
export const useRosterAsset = (): ((path: string) => string) | null => useContext(RosterAssets);
