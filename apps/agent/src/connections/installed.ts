import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { InstalledConnector } from "./types.js";

export const CONNECTORS_FILE = "connectors.json";
export const MAX_INSTALLED = 64;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const Base = {
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  description: z.string().max(4000).default(""),
  source: z.enum(["verified", "community", "custom"]),
  auth: z.enum(["none", "token", "oauth"]),
  held: z.literal("oauth").optional(),
  installedAt: z.union([z.number(), z.string()]),
  confirmedWarning: z.boolean(),
  secretEnv: z.array(z.string().regex(ENV_NAME)).max(16).optional(),
};
const Remote = z.looseObject({
  ...Base,
  transport: z.literal("remote"),
  server: z.looseObject({ url: z.string().min(1).max(2048) }),
});
const Stdio = z.looseObject({
  ...Base,
  transport: z.literal("stdio"),
  server: z.looseObject({
    package: z.string().max(400),
    version: z.string().max(100),
    integrity: z.string().max(400).optional(),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64),
  }),
});
const Entry = z.discriminatedUnion("transport", [Remote, Stdio]);

/** Installed connectors; a malformed entry is skipped alone so one bad row can't hide the rest. */
export const readInstalled = (
  dir: string,
  warn?: (event: string, meta: Record<string, unknown>) => void,
): InstalledConnector[] => {
  const path = join(dir, CONNECTORS_FILE);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    warn?.("connector.store_unreadable", {});
    return [];
  }
  const file = raw as { v?: unknown; installed?: unknown };
  if (!file || file.v !== 1 || !Array.isArray(file.installed)) {
    warn?.("connector.store_unreadable", {});
    return [];
  }
  const out: InstalledConnector[] = [];
  const seen = new Set<string>();
  for (const item of file.installed.slice(0, MAX_INSTALLED)) {
    const parsed = Entry.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) {
      warn?.("connector.entry_skipped", {});
      continue;
    }
    seen.add(parsed.data.id);
    out.push(parsed.data as InstalledConnector);
  }
  return out;
};

/** ADR 0020 revoke-all: the installed list goes empty (atomic replace, owner-only). */
export const clearInstalled = (dir: string): void => {
  const path = join(dir, CONNECTORS_FILE);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ v: 1, installed: [] })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
};
