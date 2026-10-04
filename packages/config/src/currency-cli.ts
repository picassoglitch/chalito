import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isLintedFile, lintCurrency, type CurrencyIssue } from "./currency.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((e) => {
        if (e === "node_modules" || e === ".next" || e === "dist") return [];
        const p = join(dir, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

const issues: CurrencyIssue[] = [];
for (const abs of walk(join(root, "apps"))) {
  const path = relative(root, abs);
  if (isLintedFile(path)) issues.push(...lintCurrency(path, readFileSync(abs, "utf8")));
}
if (issues.length) {
  for (const i of issues) console.error(`${i.file}:${i.line} ${i.kind}: ${i.text}`);
  console.error(`currency lint: ${issues.length} issue(s); prices belong in packages/config`);
  process.exit(1);
}
console.log("currency lint: ok");
