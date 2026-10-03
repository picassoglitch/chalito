import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { lintAssetFiles, lintMessages, lintNames, type BrandIssue } from "./lint.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

const issues: BrandIssue[] = [];
const rel = (p: string) => relative(root, p);

// 1. User-facing message catalogs and in-character copy.
for (const f of [...walk(join(root, "packages/ui/messages")), ...walk(join(root, "packages/config/copy"))]) {
  if (f.endsWith(".json")) issues.push(...lintMessages(rel(f), JSON.parse(readFileSync(f, "utf8"))));
  if (f.endsWith(".yaml") || f.endsWith(".yml")) issues.push(...lintMessages(rel(f), parse(readFileSync(f, "utf8"))));
}

// 2. Plan names.
const plansFile = join(root, "packages/config/plans.yaml");
const plans = parse(readFileSync(plansFile, "utf8"), { merge: true }) as {
  tiers: Record<string, { displayName: string }>;
};
issues.push(
  ...lintNames(
    rel(plansFile),
    Object.entries(plans.tiers).map(([id, t]) => [`tiers.${id}.displayName`, t.displayName]),
  ),
);

// 3. Cosmetic names.
const catalogFile = join(root, "packages/config/catalog.yaml");
if (existsSync(catalogFile)) {
  const catalog = parse(readFileSync(catalogFile, "utf8")) as {
    cosmetics?: Record<string, { name: Record<string, string> }>;
  };
  const names = Object.entries(catalog.cosmetics ?? {}).flatMap(([id, c]) =>
    Object.entries(c.name).map(([loc, n]) => [`cosmetics.${id}.name.${loc}`, n] as [string, string]),
  );
  issues.push(...lintNames(rel(catalogFile), names));
}

// 4. Brand assets.
issues.push(...lintAssetFiles(walk(join(root, "packages/brand/assets")).map(rel)));

if (issues.length) {
  for (const i of issues) console.error(`${i.file} [${i.where}] ${i.message}`);
  console.error(`brand lint: ${issues.length} issue(s)`);
  process.exit(1);
}
console.log("brand lint: ok");
