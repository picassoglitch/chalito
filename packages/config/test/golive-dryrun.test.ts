import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * scripts/nexo-ai-dryrun.sh against fake `supabase` and `pnpm` binaries: nothing reaches a real
 * account. Each fake logs its arguments; `supabase branches get` answers with $FAKE_BRANCH_URL.
 */
const script = fileURLToPath(new URL("../../../scripts/nexo-ai-dryrun.sh", import.meta.url));
const MAIN = "uqcbziwdgbnzehipzjxp";
const BRANCH = "abcdefghijklmnopqrst";

const run = (args: string[], env: Record<string, string> = {}) => {
  const bin = mkdtempSync(join(tmpdir(), "dryrun-"));
  const log = join(bin, "calls.log");
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    "supabase",
    `if [ "$1 $2" = "branches get" ]; then
  echo "POSTGRES_URL=\\"postgresql://postgres.$FAKE_DB_REF:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres\\""
  echo "SUPABASE_URL=\\"$FAKE_BRANCH_URL\\""
  echo "SUPABASE_ANON_KEY=\\"anon\\""
  echo "SUPABASE_SERVICE_ROLE_KEY=\\"service\\""
fi
if [ "$1 $2" = "db push" ]; then echo "push-files $(ls supabase/migrations | tr '\\n' ' ')" >> "${log}"; fi
exit 0`,
  );
  fake("pnpm", "exit 0");
  fake("jq", "exit 0");
  fake("sleep", "exit 0");
  writeFileSync(log, "");
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: bin,
      FAKE_BRANCH_URL: `https://${BRANCH}.supabase.co`,
      FAKE_DB_REF: BRANCH,
      ...env,
    },
  });
  return { ...r, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
};

describe("scripts/nexo-ai-dryrun.sh", () => {
  it("without --yes prints the plan and runs nothing", () => {
    const r = run([], { NEXO_AI_REF: MAIN });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/nothing has run/);
    expect(r.stdout).toMatch(/\[cost/);
    expect(r.calls).toEqual([]);
  });

  it("needs a valid main ref", () => {
    for (const ref of ["", "short", "UQCBZIWDGBNZEHIPZJXP"]) {
      const r = run(["--yes"], { NEXO_AI_REF: ref });
      expect(r.status, ref).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });

  it("refuses when the branch resolves to the main project, and deletes the branch it made", () => {
    for (const env of [
      { FAKE_BRANCH_URL: `https://${MAIN}.supabase.co`, FAKE_DB_REF: MAIN },
      { FAKE_BRANCH_URL: `https://${BRANCH}.supabase.co`, FAKE_DB_REF: MAIN },
      { FAKE_BRANCH_URL: `https://${BRANCH}.supabase.co`, FAKE_DB_REF: "zzzzzzzzzzzzzzzzzzzz" },
    ]) {
      const r = run(["--yes"], { NEXO_AI_REF: MAIN, ...env });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refusing/);
      expect(r.calls.some((c) => c.includes("db push") || c.includes("test db"))).toBe(false);
      expect(r.calls.at(-1)).toMatch(new RegExp(`^supabase branches delete chalito-dryrun-\\d+ --project-ref ${MAIN}`));
    }
  });

  it("runs every step against the branch only, then deletes it", () => {
    const r = run(["--yes"], { NEXO_AI_REF: MAIN, BRANCH: "golive-test" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/chalito migrations \(push\)\s+PASS/);
    expect(r.stdout).toMatch(/pgTAP\s+PASS/);
    expect(r.stdout).toMatch(/rehearsal\s+PASS/);
    const steps = r.calls.map((c) => c.split(" ").slice(0, 3).join(" "));
    expect(steps[0]).toBe("supabase branches create");
    expect(steps).toContain("supabase db push");
    expect(steps).toContain("supabase test db");
    expect(steps).toContain("pnpm --filter @chalito/rehearsal");
    expect(steps.at(-1)).toBe("supabase branches delete");
    for (const c of r.calls.filter((c) => c.includes("--db-url"))) expect(c).toContain(BRANCH);
    expect(r.calls.filter((c) => c.includes("--db-url")).join("\n")).not.toContain(MAIN);
  });

  it("--method hub needs HUB_DIR", () => {
    const r = run(["--yes", "--method", "hub"], { NEXO_AI_REF: MAIN });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
  });

  it("--method hub pushes the hub's and Chalito's files together, from a copy of HUB_DIR", () => {
    const hub = mkdtempSync(join(tmpdir(), "hub-"));
    mkdirSync(join(hub, "supabase/migrations"), { recursive: true });
    writeFileSync(join(hub, "supabase/migrations/0001_hub.sql"), "select 1;");
    const r = run(["--yes", "--method", "hub"], { NEXO_AI_REF: MAIN, HUB_DIR: hub });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/hub \+ chalito migrations\s+PASS/);
    const pushes = r.calls.filter((c) => c.startsWith("supabase db push"));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("--include-all");
    const files = r.calls.find((c) => c.startsWith("push-files"))!;
    expect(files).toContain("0001_hub.sql");
    expect(files).toContain("20261004000100_chalito_identity.sql");
    // HUB_DIR itself is untouched.
    expect(readdirSync(join(hub, "supabase/migrations"))).toEqual(["0001_hub.sql"]);
  });

  it("--keep leaves the branch", () => {
    const r = run(["--yes", "--keep"], { NEXO_AI_REF: MAIN });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith("supabase branches delete"))).toBe(false);
  });
});
