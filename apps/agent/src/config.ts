import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SigningKeyPair } from "@chalito/crypto";
import { DerivedDeviceId, Locale, Uid } from "@chalito/protocol";
import { signLocal, verifyLocal } from "./local-sig.js";

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
  /**
   * The user's Claude Code binary, pinned by `chalito claude pin` (resolved once, by a
   * human at a terminal). The daemon runs exactly this file, checked against the hash;
   * it never searches PATH.
   */
  claude: z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;
export type PairedConfig = AgentConfig & { owner: string; deviceId: string };

export const configPath = (dir: string): string => join(dir, "config.json");

export class ConfigError extends Error {
  override name = "ConfigError";
}

export class ConfigTamperedError extends ConfigError {
  override name = "ConfigTamperedError";
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
export const readConfig = (
  dir: string,
  env: Record<string, string | undefined> = process.env,
  /** With keys, the file must carry the agent's signature (the daemon always passes them). */
  verify?: { keys: SigningKeyPair },
): AgentConfig => {
  const file = configPath(dir);
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const { sig, ...body } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (verify && !verifyLocal("chalito.agent-config.v1", body, sig, verify.keys.publicKey))
        throw new ConfigTamperedError(
          `${file} was changed outside chalito (its signature doesn't match). Run \`chalito pair\` again to rewrite it.`,
        );
      raw = body;
    } catch (err) {
      if (err instanceof ConfigTamperedError) throw err;
      throw new ConfigError(`${file} is not valid JSON.`);
    }
  } else if (verify) throw new ConfigError("This computer isn't paired yet. Run `chalito pair` first.");
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

/**
 * Atomic write, 0600, signed with the agent key: `claude.path` decides what the daemon
 * runs with the API key, and `apiBase`/`firebase` where it connects, so an unsigned edit
 * must not take effect.
 */
export const writeConfig = (dir: string, c: AgentConfig, keys: SigningKeyPair): void => {
  ensureChalitoDir(dir);
  const file = configPath(dir);
  const tmp = `${file}.tmp`;
  const body = JSON.parse(JSON.stringify(AgentConfig.parse(c))) as Record<string, unknown>;
  const sig = signLocal("chalito.agent-config.v1", body, keys);
  writeFileSync(tmp, `${JSON.stringify({ ...body, sig }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
};
