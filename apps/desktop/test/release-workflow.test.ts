// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Guards on .github/workflows/release.yml: drafts only, and only from a tag or a manual dry run. */
const yml = readFileSync(join(__dirname, "../../../.github/workflows/release.yml"), "utf8");
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
});
