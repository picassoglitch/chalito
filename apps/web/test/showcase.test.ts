// @vitest-environment node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROSTER } from "@chalito/roster";
import { missingShowcase, showcase } from "@/lib/showcase";
import manifest from "../public/showcase/manifest.json";

const PUBLIC = join(__dirname, "../public");
const SRC = join(__dirname, "../src");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

describe("showcase renders", () => {
  it("every asset the landing references is in the manifest", () => {
    const ids = new Set<string>();
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/showcase\(\s*"([^"]+)"\s*\)/g)) ids.add(m[1]!);
      // Template ids: the landing builds roster-<id> from ROSTER.
      if (text.includes("showcase(`roster-${r.id}`)")) for (const r of ROSTER) ids.add(`roster-${r.id}`);
    }
    expect(ids.size).toBeGreaterThan(5);
    expect(missingShowcase([...ids], manifest.assets)).toEqual([]);
  });

  it("nothing points at public/showcase directly, only through the manifest", () => {
    for (const file of sources(SRC).filter((f) => !f.endsWith("lib/showcase.ts")))
      expect(readFileSync(file, "utf8"), file).not.toMatch(/["'`]\/?showcase\//);
  });

  it("an id missing from the manifest throws (what fails the build)", () => {
    expect(() => showcase("no-such-render")).toThrow(/not in public\/showcase\/manifest\.json/);
    expect(missingShowcase(["a", "b"], [{ id: "a" }])).toEqual(["b"]);
  });

  it("every manifest file is on disk with its recorded hash", () => {
    const sha = (f: string) =>
      createHash("sha256")
        .update(readFileSync(join(PUBLIC, f)))
        .digest("hex");
    for (const a of manifest.assets as { file: string; sha256: string; poster?: string; posterSha256?: string }[]) {
      expect(sha(a.file), a.file).toBe(a.sha256);
      if (a.poster) expect(sha(a.poster), a.poster).toBe(a.posterSha256);
    }
  });

  it("animated renders have a poster for reduced motion", () => {
    for (const a of manifest.assets) if (a.kind === "animated") expect(a.poster, a.id).toBeTruthy();
    expect(showcase("hero-chalito").poster).toMatch(/^\/showcase\/hero-chalito-poster\.webp$/);
  });
});
