import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DerivedDeviceId, Locale, Uid } from "@chalito/protocol";

/** ~/.chalito: config, policy, trusted clients, Developer-mode state and audit. 0700. */
export const chalitoDir = (home = homedir()): string => join(home, ".chalito");

export const ensureChalitoDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/**
 * ~/.chalito/config.json. `owner` and `deviceId` are written by `chalito pair`; until
 * then only the endpoints are known.
 */
export const AgentConfig = z.object({
  owner: Uid.nullable().default(null),
  deviceId: DerivedDeviceId.nullable().default(null),
  apiBase: z.url().transform((u) => u.replace(/\/+$/, "")),
  firebase: z.object({
    projectId: z.string().min(1),
    apiKey: z.string().min(1),
    databaseId: z.string().min(1).default("chalito"),
  }),
  locale: Locale.default("es"),
  /** Optional override for the user's Claude Code binary (otherwise `which claude`). */
  claudePath: z.string().min(1).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;
export type PairedConfig = AgentConfig & { owner: string; deviceId: string };

export const configPath = (dir: string): string => join(dir, "config.json");

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Locale for messages before a config exists: LANG=en* → en, anything else → es. */
export const envLocale = (env: Record<string, string | undefined>): "es" | "en" =>
  /^en/i.test(env.CHALITO_LOCALE ?? env.LC_ALL ?? env.LANG ?? "") ? "en" : "es";

/**
 * Reads config.json. Missing endpoint fields may come from the environment
 * (CHALITO_API_BASE, CHALITO_FIREBASE_PROJECT_ID, CHALITO_FIREBASE_API_KEY,
 * CHALITO_FIREBASE_DATABASE_ID), so a fresh install can pair before a file exists.
 * With the Firebase emulator variables set, the project defaults to demo-chalito.
 */
export const readConfig = (dir: string, env: Record<string, string | undefined> = process.env): AgentConfig => {
  const file = configPath(dir);
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new ConfigError(`${file} is not valid JSON.`);
    }
  }
  const fb = (raw.firebase ?? {}) as Record<string, unknown>;
  // Emulators accept any API key; the demo- project id keeps them from touching a real project.
  const emulated = Boolean(env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST);
  const merged = {
    ...raw,
    apiBase: raw.apiBase ?? env.CHALITO_API_BASE,
    firebase: {
      ...fb,
      projectId: fb.projectId ?? env.CHALITO_FIREBASE_PROJECT_ID ?? (emulated ? "demo-chalito" : undefined),
      apiKey: fb.apiKey ?? env.CHALITO_FIREBASE_API_KEY ?? (emulated ? "demo-api-key" : undefined),
      databaseId: fb.databaseId ?? env.CHALITO_FIREBASE_DATABASE_ID,
    },
    locale: raw.locale ?? envLocale(env),
  };
  const parsed = AgentConfig.safeParse(merged);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new ConfigError(`${file}: missing or invalid ${fields}.`);
  }
  return parsed.data;
};

export const isPaired = (c: AgentConfig): c is PairedConfig => c.owner !== null && c.deviceId !== null;

export const requirePaired = (c: AgentConfig): PairedConfig => {
  if (!isPaired(c)) throw new ConfigError("This computer isn't paired yet. Run `chalito pair` first.");
  return c;
};

/** Atomic write, 0600. */
export const writeConfig = (dir: string, c: AgentConfig): void => {
  ensureChalitoDir(dir);
  const file = configPath(dir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(AgentConfig.parse(c), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
};
