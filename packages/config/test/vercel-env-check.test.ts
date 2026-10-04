import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORBIDDEN, RECOMMENDED, REQUIRED, check, parseEnvLs } from "../../../scripts/vercel-env-check.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** The shape `vercel env ls` prints (banner, header, then 2+-space columns). */
const envLs = (rows: [string, string][]) =>
  [
    "Vercel CLI 48.1.0",
    "> Environment Variables found for picassoglitch/chalito-web [212ms]",
    "",
    " name                                   value               environments                        created",
    ...rows.map(([n, e]) => ` ${n.padEnd(38)} Encrypted           ${e.padEnd(35)} 2d ago`),
    "",
  ].join("\n");
const allRequired = REQUIRED.map((e) => [e.name, "Production"] as [string, string]);

describe("scripts/vercel-env-check.ts", () => {
  it("parses the table and ignores the banner and header", () => {
    expect(parseEnvLs(envLs([["NEXT_PUBLIC_HUB_URL", "Production, Preview"]]))).toEqual([
      { name: "NEXT_PUBLIC_HUB_URL", environments: "Production, Preview" },
    ]);
  });

  it("passes with every required var in Production", () => {
    const r = check(parseEnvLs(envLs(allRequired)));
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toMatch(/WARN unset\s+NEXT_PUBLIC_CHALITO_ORCHESTRATOR_BASE/);
  });

  it("fails on a missing var, or one set only for Preview", () => {
    const missing = check(parseEnvLs(envLs(allRequired.slice(1))));
    expect(missing.ok).toBe(false);
    const preview = check(parseEnvLs(envLs([...allRequired.slice(1), [REQUIRED[0]!.name, "Preview"]])));
    expect(preview.ok).toBe(false);
    expect(preview.lines.join("\n")).toMatch(/not in Production/);
  });

  it("fails on forbidden or secret-looking vars, in any environment", () => {
    for (const bad of ["NEXT_PUBLIC_CHALITO_DEV_BACKEND", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_STRIPE_SECRET"]) {
      const r = check(parseEnvLs(envLs([...allRequired, [bad, "Development"]])));
      expect(r.ok, bad).toBe(false);
    }
  });

  it("fails on empty input", () => {
    expect(check(parseEnvLs("Vercel CLI 48.1.0\n")).ok).toBe(false);
  });

  it("covers every NEXT_PUBLIC_ var apps/web reads", () => {
    const files = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
      });
    const read = new Set(
      [...files(join(root, "apps/web/src")), join(root, "apps/web/next.config.ts")].flatMap((f) =>
        [...readFileSync(f, "utf8").matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)].map((m) => m[1]!),
      ),
    );
    const listed = new Set([...REQUIRED, ...RECOMMENDED, ...FORBIDDEN].map((e) => e.name));
    expect([...read].filter((n) => !listed.has(n))).toEqual([]);
  });
});
