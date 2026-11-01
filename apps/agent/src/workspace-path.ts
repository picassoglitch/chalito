import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** A policy path as the person wrote it (`~`, `~/code`), against their home; anything else unchanged. */
export const expandHome = (p: string, home: string): string =>
  p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;

/** The real path when it exists, else the resolved one: a folder not created yet still matches. */
export const realOrResolved = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
