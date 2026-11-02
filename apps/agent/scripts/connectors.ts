// Signs packages/config/connectors.yaml like `pnpm recipes sign` (ADR 0023 §1):
//   pnpm --filter @chalito/agent exec tsx scripts/connectors.ts sign --key <keyfile> --out <file>
import { readFileSync, writeFileSync } from "node:fs";
import { KeyFile } from "./recipes.js";
import { loadBuiltinConnectors, signConnectorCatalog } from "../src/connections/catalog.js";

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const [cmd, ...args] = process.argv.slice(2);
const keyPath = flag(args, "--key");
const out = flag(args, "--out");
if (cmd !== "sign" || !keyPath || !out) {
  process.stderr.write("usage: connectors sign --key <file> --out <file>\n");
  process.exit(1);
}
const key = KeyFile.parse(JSON.parse(readFileSync(keyPath, "utf8")));
writeFileSync(out, `${JSON.stringify(await signConnectorCatalog(loadBuiltinConnectors(), key), null, 2)}\n`);
process.stdout.write(`wrote ${out} (keyId ${key.keyId})\n`);
