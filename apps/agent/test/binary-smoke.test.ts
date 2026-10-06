import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Builds the smoke entry with `bun build --compile` and runs it from an empty directory, so
 * nothing can come from node_modules. Skipped when bun isn't installed ($BUN or PATH); CI
 * runs it in the agent-binary job.
 */
const bun = process.env.BUN ?? "bun";
const hasBun = spawnSync(bun, ["--version"]).status === 0;
const root = resolve(import.meta.dirname, "..");

describe("compiled agent binary", () => {
  it.skipIf(!hasBun)(
    "loads the keyring addon and libsodium; a keychain round-trip works or is cleanly unavailable; a PTY round-trips",
    () => {
      const build = spawnSync("pnpm", ["exec", "tsx", "scripts/build.ts", "src/smoke.ts"], {
        cwd: root,
        env: { ...process.env, BUN: bun },
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
      const out = build.stdout.match(/built (.+)$/m)?.[1];
      expect(out).toBeTruthy();

      const dir = mkdtempSync(join(tmpdir(), "chalito-smoke-"));
      const bin = join(dir, "chalito-agent");
      copyFileSync(out!, bin);
      const run = spawnSync(bin, [], { cwd: dir, encoding: "utf8" });
      expect([0, 2], run.stderr).toContain(run.status);
      const report = JSON.parse(run.stdout.trim());
      expect(report).toMatchObject({ smoke: "chalito-agent", addonLoaded: true, sodium: true });
      // Remote terminal: Bun's built-in PTY works inside the compiled binary (no addon to embed).
      if (process.platform !== "win32") expect(report).toMatchObject({ pty: "ok", ptyBackend: "bun" });
      expect(report.keyring).toBe(run.status === 0 ? "ok" : "unavailable");
    },
    120_000,
  );
});
