/**
 * Compiles a chalito-agent entry into a single executable with `bun build --compile` (ADR 0004).
 *
 *   pnpm --filter @chalito/agent build [entry] [--target <triple>|host|all]
 *
 * entry defaults to src/cli.ts; output is dist/chalito-agent-<target-triple>[.exe]. The bun
 * binary comes from $BUN or PATH. Cross-target builds need that platform's
 * `@napi-rs/keyring-*` package installed, or the addon won't be embedded.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TARGETS = {
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
} as const;
type Triple = keyof typeof TARGETS;

const hostTriple = (): Triple => {
  const key = `${process.platform}-${process.arch}`;
  const map: Record<string, Triple> = {
    "linux-x64": "x86_64-unknown-linux-gnu",
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const t = map[key];
  if (!t) throw new Error(`No chalito-agent target for host ${key}`);
  return t;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = args.indexOf("--target");
const targetArg = flag >= 0 ? args.splice(flag, 2)[1] : "host";
const entry = resolve(root, args[0] ?? "src/cli.ts");
const bun = process.env.BUN ?? "bun";

const triples: Triple[] =
  targetArg === "all"
    ? (Object.keys(TARGETS) as Triple[])
    : targetArg === "host"
      ? [hostTriple()]
      : targetArg && targetArg in TARGETS
        ? [targetArg as Triple]
        : (() => {
            throw new Error(`Unknown target ${targetArg}; use one of ${Object.keys(TARGETS).join(", ")}, host, all`);
          })();

mkdirSync(join(root, "dist"), { recursive: true });
for (const triple of triples) {
  const outfile = join(root, "dist", `chalito-agent-${triple}${triple.includes("windows") ? ".exe" : ""}`);
  const res = spawnSync(
    bun,
    ["build", "--compile", "--minify", "--sourcemap", `--target=${TARGETS[triple]}`, entry, "--outfile", outfile],
    { cwd: root, stdio: "inherit" },
  );
  if (res.error)
    throw new Error(`Could not run bun (${res.error.message}); install it or set $BUN`, { cause: res.error });
  if (res.status !== 0) process.exit(res.status ?? 1);
  process.stdout.write(`built ${outfile}\n`);
}
