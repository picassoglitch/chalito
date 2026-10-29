// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Static, not `await import()` in a test: the cold transform counted against the 5s test
// timeout and timed out under full-suite load.
import { checkCsp } from "../scripts/release/plan.js";
import { DEFAULT_SSO_START_URL } from "../src/lib/session.js";
import { MIN_GLIBC } from "../src/lib/updates.js";

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

  it("the bridge release (LEGACY_BRIDGE_VERSION) refuses to build on anything but Ubuntu 22.04", () => {
    const desktop = code.slice(code.indexOf("\n  desktop:"));
    const guard = desktop.slice(desktop.indexOf("The bridge release builds on Ubuntu 22.04"));
    expect(guard).toContain("if: matrix.os == 'linux'");
    expect(guard).toMatch(/LEGACY_BRIDGE_VERSION = .*packages\/releases\/src\/manifest\.ts/);
    expect(guard).toMatch(/"\$os" != "22\.04"[^\n]*\n[^\n]*exit 1/);
    // Before the build: a wrong-runner bridge never produces artifacts.
    expect(desktop.indexOf("The bridge release builds on Ubuntu 22.04")).toBeLessThan(desktop.indexOf("pnpm install"));
  });

  it("the default token is read-only; only the draft job can write", () => {
    expect(yml).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect((code.match(/contents: write/g) ?? []).length).toBe(1);
    const draft = code.slice(code.indexOf("\n  draft:"));
    expect(draft).toContain("contents: write");
  });

  it("every release writes latest-v2.json; the frozen legacy latest.json comes only from the CLI's bridge check", () => {
    const step = code.slice(code.indexOf("- name: Manifest"), code.indexOf("- name: Draft notes"));
    expect(step).toContain("release manifest");
    expect(step).toContain('--out-dir "$RUNNER_TEMP/dist"');
    expect(step).not.toMatch(/--out "|latest\.json"/);
    expect(code).toContain('"$RUNNER_TEMP/dist/latest-v2.json"');
  });

  it("builds the Linux release on Ubuntu 24.04: 22.04's bundled WebKitGTK leaves pet trails", () => {
    const linux = /- os: linux\n\s*runner: (\S+)/.exec(code);
    expect(linux?.[1]).toBe("ubuntu-24.04");
    // 24.04 links against glibc 2.39: the packages must refuse an older system instead of failing at start.
    const conf = JSON.parse(readFileSync(join(__dirname, "../src-tauri/tauri.conf.json"), "utf8")) as {
      bundle: { linux: { deb: { depends: string[] }; rpm?: { depends?: string[] } } };
    };
    // The updater's floor and the .deb's are one number.
    expect(conf.bundle.linux.deb.depends).toContain(`libc6 (>= ${MIN_GLIBC})`);
    // tauri-bundler makes each rpm entry a capability name: "glibc >= 2.39" would be a package nobody provides.
    for (const d of conf.bundle.linux.rpm?.depends ?? []) expect(d).not.toMatch(/[<>=]/);
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

  it("public app config: from repo variables (never secrets); a release refuses to build unwired", () => {
    const step = code.slice(code.indexOf("name: Public app config"), code.indexOf("name: Build\n"));
    expect(step.length).toBeGreaterThan(0);
    expect(code.indexOf("name: Public app config")).toBeLessThan(code.indexOf("name: Build\n"));
    expect(step).toContain("W_SUPABASE_URL: ${{ vars.SUPABASE_URL }}");
    expect(step).toContain("W_SUPABASE_PUBLISHABLE_KEY: ${{ vars.SUPABASE_PUBLISHABLE_KEY }}");
    expect(code).not.toMatch(/secrets\.SUPABASE/);
    expect(step).toMatch(/sb_secret_\*/);
    // Unwired: a release exits 1; a dry run warns and labels its artifact.
    expect(step).toMatch(
      /elif \[ "\$DRY_RUN" = true \]; then[\s\S]*::warning::[\s\S]*else[\s\S]*::error::[\s\S]*exit 1/,
    );
    expect(code).toContain("release-${{ matrix.os }}${{ steps.wiring.outputs.wired != 'true' && '-unwired' || '' }}");
    expect(code).toMatch(/unwired build; not drafting/);
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

  // ADR 0028 §A: one api address, written once in release.yml; the app's CSP and the updater
  // endpoint must agree with it, or an installed build can't reach the api or find updates.
  it("CHALITO_API_BASE is set once and the desktop CSP allows exactly that api", () => {
    const bases = [...yml.matchAll(/^\s*CHALITO_API_BASE:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
    expect(bases).toEqual(["https://api.chalito.chalyb.com"]);
    const conf = JSON.parse(readFileSync(join(__dirname, "../src-tauri/tauri.conf.json"), "utf8")) as {
      app: { security: { csp: string } };
    };
    expect(() => checkCsp(conf.app.security.csp, bases[0]!)).not.toThrow();
    // The plan gets the same value, and derives the updater endpoint from it.
    expect(code).toMatch(/release plan [^\n]*\n?[^\n]*--api "\$CHALITO_API_BASE"/);
    // …and the build runs with the overlay the plan checked (it carries the updater endpoint).
    expect(code).toMatch(/pnpm tauri build --config src-tauri\/tauri\.release\.conf\.json/);
  });

  it("CHALITO_SSO_START_URL is set once, is the hub's desktop sign-in page, and the app defaults to it", () => {
    const urls = [...yml.matchAll(/^\s*CHALITO_SSO_START_URL:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
    expect(urls).toEqual(["https://www.chalyb.com/app/chalito/auth/desktop"]);
    expect(code).toContain('echo "VITE_SSO_START_URL=$CHALITO_SSO_START_URL"');
    expect(DEFAULT_SSO_START_URL).toBe(urls[0]);
    // Opened in the system browser (SsoFlow → openUrl), never fetched: the CSP doesn't need it.
    const conf = JSON.parse(readFileSync(join(__dirname, "../src-tauri/tauri.conf.json"), "utf8")) as {
      app: { security: { csp: string } };
    };
    expect(conf.app.security.csp).not.toContain("www.chalyb.com");
  });
});
