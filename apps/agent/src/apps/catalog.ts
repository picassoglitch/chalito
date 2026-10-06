import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fromB64url, verifyDetached } from "@chalito/crypto";
import { Recipe, RecipeCatalog, SignedRecipeCatalog, type AppId } from "@chalito/protocol";
import { parse as parseYaml } from "yaml";
import builtinJson from "../../../../recipes/catalog.json" with { type: "json" };
import type { Logger } from "../redact.js";
import { CATALOG_KEYS } from "./catalog-keys.js";

/**
 * The recipes this agent knows (engine contract v2 §1):
 * - built in: recipes/catalog.json, compiled into the agent (same trust as its code);
 * - curated updates: the signed catalog from `GET /v1/recipes/catalog`, used only when a
 *   compiled-in key verifies it and it's newer than the built-in one;
 * - custom: the person's own ~/.chalito/recipes/*.yaml, usable only once enabled on this
 *   computer, and only while the file still hashes the same as when it was enabled.
 */

/** Parsed once; a broken built-in catalog is a build bug (recipes.test.ts guards it). */
export const BUILTIN_CATALOG: RecipeCatalog = RecipeCatalog.parse(builtinJson);

export type VerifyResult =
  | { ok: true; catalog: RecipeCatalog; keyId: string }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" };

/** Checks a served catalog against the compiled-in keys (or the ones a test passes). */
export const verifyCatalog = async (
  raw: unknown,
  keys: Readonly<Record<string, string>> = CATALOG_KEYS,
): Promise<VerifyResult> => {
  const parsed = SignedRecipeCatalog.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const { keyId, body, sig, ctx } = parsed.data;
  const pub = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
  if (!pub) return { ok: false, reason: "unknown_key" };
  // Over the body exactly as served (zod strips nothing here: every object is strict).
  const ok = await verifyDetached(ctx, (raw as { body: unknown }).body, sig, await fromB64url(pub));
  return ok ? { ok: true, catalog: body, keyId } : { ok: false, reason: "bad_signature" };
};

/** One entry of what the agent offers: a recipe, where it came from, and whether it may be used. */
export interface CatalogEntry {
  recipe: Recipe;
  custom: boolean;
  /** Curated: always. Custom: enabled on this computer with the file's current hash. */
  enabled: boolean;
  /** Custom only: sha256 of the recipe file as it is now. */
  sha256?: string;
}

/** A custom recipe file that didn't load (shown to the person locally; never uploaded). */
export interface CustomProblem {
  file: string;
  reason: "invalid" | "shadows_curated" | "duplicate_id" | "too_large";
}

export const CUSTOM_DIR = "recipes";
const MAX_CUSTOM_BYTES = 64 * 1024;
const MAX_CUSTOM_FILES = 100;

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Reads ~/.chalito/recipes/*.yaml|yml|json. Never throws; problems are returned per file. */
export const loadCustomRecipes = (
  dir: string,
  curatedIds: ReadonlySet<string>,
): { recipes: { recipe: Recipe; sha256: string; file: string }[]; problems: CustomProblem[] } => {
  const folder = join(dir, CUSTOM_DIR);
  const recipes: { recipe: Recipe; sha256: string; file: string }[] = [];
  const problems: CustomProblem[] = [];
  if (!existsSync(folder)) return { recipes, problems };
  let names: string[];
  try {
    names = readdirSync(folder)
      .filter((n) => /\.(ya?ml|json)$/i.test(n))
      .sort()
      .slice(0, MAX_CUSTOM_FILES);
  } catch {
    return { recipes, problems };
  }
  const seen = new Set<string>();
  for (const name of names) {
    const path = join(folder, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (st.size > MAX_CUSTOM_BYTES) {
        problems.push({ file: name, reason: "too_large" });
        continue;
      }
      const text = readFileSync(path, "utf8");
      const r = Recipe.safeParse(/\.json$/i.test(name) ? JSON.parse(text) : parseYaml(text));
      if (!r.success) {
        problems.push({ file: name, reason: "invalid" });
        continue;
      }
      // A custom recipe can't stand in for a curated app (it would change what a curated id runs).
      if (curatedIds.has(r.data.id)) {
        problems.push({ file: name, reason: "shadows_curated" });
        continue;
      }
      if (seen.has(r.data.id)) {
        problems.push({ file: name, reason: "duplicate_id" });
        continue;
      }
      seen.add(r.data.id);
      recipes.push({ recipe: r.data, sha256: sha256Hex(text), file: name });
    } catch {
      problems.push({ file: name, reason: "invalid" });
    }
  }
  return { recipes, problems };
};

/** What policy.yaml `apps.custom` says (policy/schema.ts): enabled with the file's hash. */
export type CustomEnables = Readonly<Record<string, { enabled: boolean; sha256: string }>>;

export interface CatalogDeps {
  dir: string;
  /** The custom enables from the signed local policy. */
  customEnables: () => CustomEnables;
  log: Logger;
  /** Built-in catalog (tests pass their own). */
  builtin?: RecipeCatalog;
  /** Compiled-in keys (tests pass the dev key). */
  keys?: Readonly<Record<string, string>>;
}

/**
 * The agent's catalog: curated (built-in, or a newer verified remote one) plus the person's
 * custom recipes. Cheap to read: custom files are re-read on `entries()` so an edit shows up
 * (and disables the recipe until it's enabled again).
 */
export class AppCatalog {
  #curated: RecipeCatalog;
  #source: "builtin" | "remote";

  constructor(private readonly d: CatalogDeps) {
    this.#curated = d.builtin ?? BUILTIN_CATALOG;
    this.#source = "builtin";
  }

  get source() {
    return this.#source;
  }
  get issuedAt() {
    return this.#curated.issuedAt;
  }

  /**
   * Offers a catalog served by the api. Used only if a compiled-in key verifies it and it's newer
   * than the one in use; a curated recipe the built-in catalog has is never dropped by an update
   * (an update that removes an app keeps the built-in recipe).
   */
  async offer(raw: unknown): Promise<VerifyResult & { applied?: boolean }> {
    const v = await verifyCatalog(raw, this.d.keys ?? CATALOG_KEYS);
    if (!v.ok) {
      this.d.log.warn("recipes.catalog_rejected", { reason: v.reason });
      return v;
    }
    if (v.catalog.issuedAt <= this.#curated.issuedAt) return { ...v, applied: false };
    const builtin = this.d.builtin ?? BUILTIN_CATALOG;
    const ids = new Set(v.catalog.recipes.map((r) => r.id));
    this.#curated = {
      ...v.catalog,
      recipes: [...v.catalog.recipes, ...builtin.recipes.filter((r) => !ids.has(r.id))],
    };
    this.#source = "remote";
    this.d.log.info("recipes.catalog_updated", { keyId: v.keyId, issuedAt: v.catalog.issuedAt });
    return { ...v, applied: true };
  }

  curated(): Recipe[] {
    return this.#curated.recipes;
  }

  custom() {
    return loadCustomRecipes(this.d.dir, new Set(this.#curated.recipes.map((r) => r.id)));
  }

  entries(): CatalogEntry[] {
    const enables = this.d.customEnables();
    return [
      ...this.#curated.recipes.map((recipe) => ({ recipe, custom: false, enabled: true })),
      ...this.custom().recipes.map(({ recipe, sha256 }) => {
        const e = Object.hasOwn(enables, recipe.id) ? enables[recipe.id] : undefined;
        return { recipe, custom: true, enabled: !!e?.enabled && e.sha256 === sha256, sha256 };
      }),
    ];
  }

  get(id: AppId | string): CatalogEntry | undefined {
    return this.entries().find((e) => e.recipe.id === id);
  }
}

/** Fetches the served catalog. Network or shape problems resolve null (the agent keeps what it has). */
export type CatalogFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const fetchCatalog = async (fetchFn: CatalogFetch, apiBase: string): Promise<unknown> => {
  try {
    const res = await fetchFn(`${apiBase}/v1/recipes/catalog`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};
