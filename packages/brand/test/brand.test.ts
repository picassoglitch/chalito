import { describe, expect, it } from "vitest";
import {
  MAX_NAME_GRAPHEMES,
  formatCompanionTitle,
  lintAssetFiles,
  lintMessages,
  lintNames,
  sanitizeCompanionName,
} from "../src/index.js";

describe("formatCompanionTitle", () => {
  it("un-renamed companion is just Chalito", () => {
    expect(formatCompanionTitle("Batman", false, "es")).toEqual({ title: "Chalito", credit: null });
  });

  it("credit line follows the user's language", () => {
    expect(formatCompanionTitle("Batman", true, "en").credit).toBe("⁨Batman⁩ · powered by Chalito Bot");
    expect(formatCompanionTitle("Batman", true, "es").credit).toBe("⁨Batman⁩ · impulsado por Chalito Bot");
  });

  it("keeps emoji graphemes intact when clamping", () => {
    const family = "👨‍👩‍👧";
    const name = family.repeat(50);
    const clean = sanitizeCompanionName(name);
    expect([...new Intl.Segmenter().segment(clean)]).toHaveLength(MAX_NAME_GRAPHEMES);
    expect(clean.startsWith(family)).toBe(true);
  });

  it("isolates RTL names and strips bidi overrides", () => {
    const t = formatCompanionTitle("‮دب‬", true, "en");
    expect(t.title).toBe("دب");
    expect(t.credit).toBe("⁨دب⁩ · powered by Chalito Bot");
  });

  it("a name that sanitizes to nothing falls back to Chalito", () => {
    expect(formatCompanionTitle(" ‏\u0007 ", true, "es")).toEqual({ title: "Chalito", credit: null });
  });
});

describe("brand lint", () => {
  it("passes integration descriptions under integrations.*", () => {
    expect(lintMessages("es.json", { integrations: { chatgpt: { connect: "Conecta tu ChatGPT" } } })).toEqual([]);
  });

  it("fails provider names elsewhere", () => {
    expect(lintMessages("en.json", { home: { title: "Chalito for Claude" } })).toHaveLength(1);
  });

  it("fails provider names in plan or cosmetic names, even when descriptive", () => {
    expect(lintNames("plans.yaml", [["tiers.lite.displayName", "Chalito for Claude"]])).toHaveLength(1);
    expect(lintNames("catalog.yaml", [["cosmetics.hat.name.es", "Gorro Grok"]])).toHaveLength(1);
    expect(lintNames("plans.yaml", [["tiers.lite.displayName", "Lite"]])).toEqual([]);
  });

  it("fails old names anywhere, including integrations.*", () => {
    expect(lintMessages("es.json", { integrations: { x: "Abre Director" } })).toHaveLength(1);
    expect(lintNames("plans.yaml", [["t", "Chalyb Partner Pro"]])).toHaveLength(1);
  });

  it("fails provider logo files among brand assets", () => {
    expect(lintAssetFiles(["packages/brand/assets/openai-logo.svg", "packages/brand/assets/chalito.svg"])).toHaveLength(
      1,
    );
  });
});
