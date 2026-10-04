// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Guards on .github/workflows/release.yml: drafts only, and only from a tag or a manual dry run. */
// Windows checkouts may convert line endings: match on LF regardless.
const yml = readFileSync(join(__dirname, "../../../.github/workflows/release.yml"), "utf8").replace(/\r\n/g, "\n");
const code = yml
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("release workflow", () => {
  it("triggers only on v* tags and manual dispatch", () => {
    const on = yml.slice(yml.indexOf("\non:"), yml.indexOf("\npermissions:"));
    expect(on).toMatch(/push:\s*\n\s*tags: \["v\*"\]/);
    expect(on).toContain("workflow_dispatch:");
    expect(on).not.toMatch(/pull_request|schedule|branches:/);
  });

  it("creates drafts only: nothing publishes or un-drafts a release", () => {
    const creates = code.match(/gh release create[^\n]*/g) ?? [];
    expect(creates.length).toBe(1);
    expect(creates[0]).toContain("--draft");
    expect(code).not.toMatch(/--draft=false|draft: false|releaseDraft: false|gh release edit|publish: true/);
    // Uploading assets to a release refuses an already published one.
    expect(code).toMatch(/already published; not touching it/);
  });

  it("the default token is read-only; only the draft job can write", () => {
    expect(yml).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect((code.match(/contents: write/g) ?? []).length).toBe(1);
    const draft = code.slice(code.indexOf("\n  draft:"));
    expect(draft).toContain("contents: write");
  });

  it("dry runs never create a release", () => {
    expect(code).toMatch(/name: Draft release\n\s*if: needs\.meta\.outputs\.dry_run != 'true'/);
  });

  it("checks the unsigned label on every build", () => {
    expect(code).toContain("Unsigned builds are labelled unsigned");
  });

  it("exports a signing variable only when its secret is set (Tauri treats set-but-empty as present)", () => {
    const names = [
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TENANT_ID",
      "ARTIFACT_SIGNING_ENDPOINT",
      "ARTIFACT_SIGNING_ACCOUNT",
      "ARTIFACT_SIGNING_PROFILE",
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
      "APPLE_API_ISSUER",
      "APPLE_API_KEY",
      "APPIMAGE_SIGN_KEY",
      "APPIMAGETOOL_SIGN_PASSPHRASE",
    ];
    for (const n of names) {
      // Never mapped straight from a secret or variable into the environment…
      expect(code).not.toMatch(new RegExp(`\\n\\s+${n}: \\$\\{\\{`));
      // …only through the step that skips empty values.
      expect(code).toMatch(new RegExp(`\\n\\s+S_${n}: \\$\\{\\{ (secrets|vars)\\.${n} \\}\\}`));
    }
    expect(code).toContain('[ -n "$v" ] || continue');
  });

  it("the webview CSP lets the desktop reach the api the release builds point at", () => {
    const api = /\n {2}CHALITO_API_BASE: (https:\/\/[^\s/]+)/.exec(yml)?.[1];
    expect(api).toBeTruthy();
    const conf = JSON.parse(readFileSync(join(__dirname, "../src-tauri/tauri.conf.json"), "utf8")) as {
      app: { security: { csp: string } };
    };
    const connect = conf.app.security.csp.split(";").find((d) => d.trim().startsWith("connect-src"))!;
    expect(connect.trim().split(/\s+/)).toContain(api);
  });

  it("macOS: installs the darwin-x64 keyring addon (lockfile-pinned) and smoke-tests both arches before the sidecar", () => {
    const keyring = code.indexOf("name: darwin-x64 keyring addon (explicit)");
    const smoke = code.indexOf("name: Smoke the compiled agent");
    const sidecar = code.indexOf("name: Build the agent sidecar");
    expect(keyring).toBeGreaterThan(0);
    expect(keyring).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(sidecar);
    const step = code.slice(keyring, smoke);
    expect(step).toContain("if: matrix.os == 'macos'");
    expect(step).toContain("pnpm-lock.yaml");
    expect(step).toMatch(/integrity mismatch/);
    expect(code.slice(smoke, sidecar)).toContain("arch -x86_64");
  });
});
