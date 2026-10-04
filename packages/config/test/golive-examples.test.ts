import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The go-live examples stay complete: terraform.tfvars.example lists every Terraform variable, each
 * service's .env.example lists every env var its code reads, and every env var the api *requires*
 * is wired by Chalyb's engine module or hub patch 06 (whose secrets Chalito's Terraform creates and
 * grants to the api).
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
const ENV_READ =
  /\benv\("([A-Z][A-Z0-9_]+)"\)|process\.env\.([A-Z][A-Z0-9_]+)|\benv\.([A-Z][A-Z0-9_]+)|process\.env\[["']([A-Z][A-Z0-9_]+)/g;
const envRead = (srcs: string[], requiredOnly = false) =>
  [
    ...new Set(
      srcs.flatMap((f) =>
        [...readFileSync(f, "utf8").matchAll(requiredOnly ? /\benv\("([A-Z][A-Z0-9_]+)"\)/g : ENV_READ)].map((m) =>
          m.slice(1).find(Boolean)!,
        ),
      ),
    ),
  ].sort();
const mentions = (text: string, name: string) => new RegExp(`\\b${name}\\b`).test(text);

describe("terraform.tfvars.example", () => {
  it("lists every variable in variables.tf", () => {
    const vars = [...read("infra/terraform/envs/dev/variables.tf").matchAll(/^variable "([a-z0-9_]+)"/gm)].map(
      (m) => m[1]!,
    );
    const example = read("infra/terraform/envs/dev/terraform.tfvars.example");
    expect(vars.filter((v) => !new RegExp(`^${v}\\s*=`, "m").test(example))).toEqual([]);
  });
});

describe(".env.example per service", () => {
  const apps: [string, string[]][] = [
    ["api", ["apps/api/src"]],
    ["notifier", ["apps/notifier/src"]],
    ["orchestrator", ["apps/orchestrator/src"]],
    ["mcp-gateway", ["apps/mcp-gateway/src"]],
    ["avatar-jobs", ["apps/avatar-jobs/src"]],
    ["web", ["apps/web/src", "apps/web/next.config.ts"]],
  ];
  for (const [app, dirs] of apps)
    it(`${app} lists every env var its code reads`, () => {
      const srcs = dirs.flatMap((d) =>
        statSync(join(root, d)).isDirectory() ? files(join(root, d)) : [join(root, d)],
      );
      const example = read(`apps/${app}/.env.example`);
      expect(envRead(srcs).filter((n) => !mentions(example, n))).toEqual([]);
    });

  it("holds no values for secrets", () => {
    for (const [app] of apps) {
      const lines = read(`apps/${app}/.env.example`).split("\n");
      lines.forEach((l, i) => {
        if (/\[secret\]/.test(l)) {
          // The variables a [secret] comment introduces are empty until the next blank or comment line.
          for (let j = i + 1; j < lines.length && /^[A-Z]/.test(lines[j]!); j++)
            expect(lines[j], `${app}: ${lines[j]}`).toMatch(/^[A-Z0-9_]+=$/);
        }
      });
    }
  });
});

describe("the api's required env is wired (Chalyb engine module + hub patch 06)", () => {
  const patch = read("docs/integrations/chalyb-hub-patches/06-terraform-chalito-engine.patch");
  const main = read("infra/terraform/envs/dev/main.tf");
  /** The module injects these for every engine: the secret_env_names trio, CHALYB_BASE_URL, PUBLIC_URL. */
  const FROM_MODULE = ["CHALITO_ADMIN_TOKEN", "CHALITO_SSO_SECRET", "DATABASE_URL", "CHALYB_BASE_URL"];
  const added = patch
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .join("\n");
  const extraSecrets = [...added.matchAll(/^\+#\s+([A-Z][A-Z0-9_]+)\s+=\s+"(chalito-[a-z0-9-]+)"/gm)].map(
    (m) => [m[1]!, m[2]!] as const,
  );

  it("names every required var", () => {
    const required = envRead(files(join(root, "apps/api/src")), true);
    expect(required.filter((n) => !FROM_MODULE.includes(n) && !mentions(added, n))).toEqual([]);
  });

  it("mounts only secrets Chalito's Terraform creates and grants to the api", () => {
    expect(extraSecrets.length).toBeGreaterThan(0);
    for (const [, id] of extraSecrets)
      expect(main, id).toMatch(new RegExp(`"${id}"\\s*=\\s*(concat\\(\\[[^\\]]*\\],\\s*)?local\\.api_list`));
  });

  it("never creates a secret the engine module owns", () => {
    for (const owned of ["chalito-admin-token", "chalito-sso-secret", "chalito-database-url"])
      expect(main).not.toMatch(new RegExp(`^\\s*"${owned}"\\s*=`, "m"));
  });
});
