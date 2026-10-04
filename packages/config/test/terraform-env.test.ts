import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * R-L12: every environment variable a Cloud Run service *requires* (`env("NAME")` in its src) is
 * wired in infra/terraform/envs/dev/main.tf under that exact name (env or secret_env), so a deploy
 * can't come up with a missing or misnamed secret. Names Chalyb's engine module provides are listed.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const main = readFileSync(join(root, "infra/terraform/envs/dev/main.tf"), "utf8");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
const required = (app: string) =>
  [
    ...new Set(
      files(join(root, "apps", app, "src")).flatMap((f) =>
        [...readFileSync(f, "utf8").matchAll(/\benv\("([A-Z0-9_]+)"\)/g)].map((m) => m[1]!),
      ),
    ),
  ].sort();
/** The body of `module "<name>" { … }` (to the next top-level block). */
const block = (name: string) => {
  const start = main.indexOf(`module "${name}" {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = main.slice(start + 1).search(/\n(module|resource|locals|data) "/);
  return main.slice(start, next < 0 ? undefined : start + 1 + next);
};
/** Provided by Chalyb's engine module through var.hub_admin_token_secret (local.hub_bearer). */
const FROM_HUB = new Set(["CHALITO_ADMIN_TOKEN"]);

describe("Terraform wires every required env var by the name the code reads (R-L12)", () => {
  for (const [app, mod] of [
    ["notifier", "notifier"],
    ["orchestrator", "orchestrator"],
    ["mcp-gateway", "mcp_gateway"],
  ] as const)
    it(app, () => {
      const b = block(mod);
      const missing = required(app).filter((n) => !FROM_HUB.has(n) && !new RegExp(`\\b${n}\\s*=`).test(b));
      expect(missing).toEqual([]);
      if (required(app).some((n) => FROM_HUB.has(n))) expect(b).toMatch(/local\.hub_bearer/);
    });
});
