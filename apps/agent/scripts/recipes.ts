/**
 * The curated recipe catalog (engine contract v2 §1).
 *
 *   pnpm recipes build [--bump]          recipes/*.yaml → recipes/catalog.json (keeps issuedAt unless --bump)
 *   pnpm recipes check                   fails when catalog.json is out of date with the sources
 *   pnpm recipes sign --key <file> [--out <file>]
 *                                        signs catalog.json → a SignedRecipeCatalog (what the api serves)
 *   pnpm recipes keygen --id <keyId> --out <file>
 *                                        a new Ed25519 key pair (the production one is an owner action,
 *                                        made and kept offline; docs/OPS.md "Recipe catalog signing key")
 *
 * Each source file is a Recipe plus a `verification` block (when it was checked, against what,
 * and which fields could not be confirmed). The block stays in the source only.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningKeyPair, fromB64url, signDetached, toB64url } from "@chalito/crypto";
import { Recipe, RecipeCatalog, type SignedRecipeCatalog } from "@chalito/protocol";
import { parse } from "yaml";
import { z } from "zod";

export const RECIPES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../recipes");
export const CATALOG_FILE = join(RECIPES_DIR, "catalog.json");

export const Verification = z
  .object({
    checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sources: z.array(z.string().min(1)).min(1),
    unverified: z.array(z.object({ field: z.string().min(1), note: z.string().min(1) }).strict()).default([]),
  })
  .strict();

/** Reads and validates every source; throws listing each bad file. */
export const readSources = (dir = RECIPES_DIR) => {
  const errors: string[] = [];
  const out: { recipe: Recipe; verification: z.infer<typeof Verification>; file: string }[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const raw = parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    const { verification, ...rest } = raw ?? {};
    const r = Recipe.safeParse(rest);
    const v = Verification.safeParse(verification);
    if (!r.success)
      errors.push(`${file}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    else if (!v.success) errors.push(`${file}: verification: ${v.error.issues.map((i) => i.message).join("; ")}`);
    else if (`${r.data.id}.yaml` !== file) errors.push(`${file}: the file name must be <id>.yaml`);
    else out.push({ recipe: r.data, verification: v.data, file });
  }
  if (errors.length) throw new Error(`Invalid recipes:\n${errors.join("\n")}`);
  return out;
};

export const buildCatalog = (issuedAt: number, dir = RECIPES_DIR): RecipeCatalog =>
  RecipeCatalog.parse({ v: 1, issuedAt, recipes: readSources(dir).map((s) => s.recipe) });

const currentIssuedAt = (): number | null => {
  if (!existsSync(CATALOG_FILE)) return null;
  return (JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as { issuedAt: number }).issuedAt;
};

export const catalogText = (c: RecipeCatalog) => `${JSON.stringify(c, null, 2)}\n`;

/** The KeyFile format: `{keyId, publicKey, secretKey}` (unpadded base64url; secretKey is libsodium's 64 bytes). */
export const KeyFile = z.object({ keyId: z.string(), publicKey: z.string(), secretKey: z.string() }).strict();

export const signCatalog = async (
  catalog: RecipeCatalog,
  key: z.infer<typeof KeyFile>,
): Promise<SignedRecipeCatalog> => ({
  ctx: "chalito.recipe-catalog.v1",
  keyId: key.keyId,
  body: catalog,
  sig: await signDetached("chalito.recipe-catalog.v1", catalog, await fromB64url(key.secretKey)),
});

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const main = async (argv: string[]) => {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "build": {
      const issuedAt = args.includes("--bump") ? Date.now() : (currentIssuedAt() ?? Date.now());
      writeFileSync(CATALOG_FILE, catalogText(buildCatalog(issuedAt)));
      process.stdout.write(`wrote ${CATALOG_FILE}\n`);
      return 0;
    }
    case "check": {
      const issuedAt = currentIssuedAt();
      if (issuedAt === null || readFileSync(CATALOG_FILE, "utf8") !== catalogText(buildCatalog(issuedAt))) {
        process.stderr.write("recipes/catalog.json is out of date: run `pnpm recipes build --bump`\n");
        return 1;
      }
      return 0;
    }
    case "sign": {
      const keyPath = flag(args, "--key");
      if (!keyPath) throw new Error("--key <file> is required");
      const key = KeyFile.parse(JSON.parse(readFileSync(keyPath, "utf8")));
      const catalog = RecipeCatalog.parse(JSON.parse(readFileSync(CATALOG_FILE, "utf8")));
      const out = flag(args, "--out") ?? join(RECIPES_DIR, "catalog.signed.json");
      writeFileSync(out, `${JSON.stringify(await signCatalog(catalog, key), null, 2)}\n`);
      process.stdout.write(`wrote ${out} (keyId ${key.keyId})\n`);
      return 0;
    }
    case "keygen": {
      const id = flag(args, "--id");
      const out = flag(args, "--out");
      if (!id || !out) throw new Error("--id <keyId> and --out <file> are required");
      if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a key`);
      const kp = await generateSigningKeyPair();
      writeFileSync(
        out,
        `${JSON.stringify({ keyId: id, publicKey: await toB64url(kp.publicKey), secretKey: await toB64url(kp.secretKey) }, null, 2)}\n`,
        { mode: 0o600 },
      );
      process.stdout.write(`wrote ${out}; public key ${await toB64url(kp.publicKey)}\n`);
      return 0;
    }
    default:
      process.stderr.write(
        "usage: recipes build [--bump] | check | sign --key <file> [--out <file>] | keygen --id <id> --out <file>\n",
      );
      return 1;
  }
};

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
