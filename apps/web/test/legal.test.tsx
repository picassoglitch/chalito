import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBlocks, safeHref } from "@/lib/markdown";
import { fillLegal, isReviewed, parseLiability } from "@/lib/legal-text";

const legal = (f: string) => readFileSync(resolve(process.cwd(), "../../packages/config/legal", f), "utf8");

describe("legal pages (packages/config/legal)", () => {
  it("the terms quote the Developer-mode clause verbatim, with its version (checklist 2.2)", () => {
    for (const l of ["es", "en"] as const) {
      const clause = parseLiability(legal(`devmode-liability.${l}.md`));
      const terms = fillLegal(legal(`terms.${l}.md`), clause);
      expect(terms).not.toContain("{devmode");
      expect(terms).toContain(`> ${clause.text.split("\n")[0]}`);
      expect(terms).toMatch(new RegExp(`(versión|version) ${clause.version}\\b`));
    }
  });

  it("every draft says it's a draft, names the processors, and has the same sections in ES and EN", () => {
    for (const doc of ["privacy", "terms"]) {
      const es = legal(`${doc}.es.md`);
      const en = legal(`${doc}.en.md`);
      expect(es).toContain("BORRADOR, pendiente de revisión legal");
      expect(en).toContain("DRAFT, pending legal review");
      expect(es.match(/^## /gm)?.length).toBe(en.match(/^## /gm)?.length);
    }
    for (const p of ["Supabase", "Google Cloud", "Twilio", "Meta", "OpenAI", "Anthropic", "xAI", "Google AI"])
      for (const l of ["es", "en"]) expect(legal(`privacy.${l}.md`)).toContain(p);
    expect(legal("privacy.es.md")).toContain("ARCO");
    expect(legal("privacy.es.md")).toContain("LFPDPPP");
  });

  it("stays a draft until legal.yaml says reviewed: true", () => {
    expect(isReviewed(legal("legal.yaml"))).toBe(false);
    expect(isReviewed("reviewed: true")).toBe(true);
    expect(isReviewed("reviewed: 'true'")).toBe(false);
    expect(isReviewed("")).toBe(false);
  });
});

describe("Markdown (own texts only, no HTML)", () => {
  it("parses headings, paragraphs, lists and quotes", () => {
    expect(parseBlocks("# T\n\nuno\ndos\n\n- a\n- b\n\n> q1\n> q2")).toEqual([
      { t: "h", level: 1, text: "T" },
      { t: "p", text: "uno dos" },
      { t: "ul", items: ["a", "b"] },
      { t: "quote", lines: ["q1", "q2"] },
    ]);
  });
  it("links only to app routes, https and mailto", () => {
    expect(safeHref("/privacidad")).toBe("/privacidad");
    expect(safeHref("https://chalyb.com/x")).toBe("https://chalyb.com/x");
    expect(safeHref("mailto:privacidad@example.com")).toBe("mailto:privacidad@example.com");
    for (const bad of ["javascript:alert(1)", "//evil.example", "/api/x", "http://x.example", "data:text/html,x"])
      expect(safeHref(bad)).toBeNull();
  });
});
