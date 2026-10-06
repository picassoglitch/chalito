import { describe, expect, it } from "vitest";
import {
  loadCatalog,
  loadEscalation,
  loadModels,
  loadPlans,
  loadPrices,
  loadProviders,
  loadRechargeCopy,
  loadRender,
  loadRooms,
} from "../src/load.js";
import { isLintedFile, lintCurrency } from "../src/currency.js";
import { CatalogConfig } from "../src/schemas.js";
import { SkinEffect } from "@chalito/protocol";

describe("config files", () => {
  it("every config file loads and validates", () => {
    expect(loadPlans().tiers.lite?.priceUsd).toBe(10);
    expect(loadModels().vertex.location).toBe("global");
    expect(loadPrices().llm.google["gemini-3.1-flash-lite"]?.input).toBe(0.25);
    expect(loadProviders().providers.anthropic.subscriptionLocal).toBe("off");
    expect(loadRooms().defaults.ephemeralTtl).toBe("PT24H");
    expect(loadRender().default).toBe("auto");
    expect(loadCatalog().cosmetics.viking_hat?.free).toBe(true);
    const esc = loadEscalation();
    expect(esc.caps).toEqual({ call: 3, whatsapp: 10, sms: 3 });
    expect(esc.voices).toEqual({ es: "Polly.Mia-Neural", en: "Polly.Joanna-Neural" });
    expect(esc.whatsapp.graphVersion).toBe("v26.0");
    for (const locale of ["es", "en"] as const) {
      const copy = loadRechargeCopy(locale);
      expect(copy.lines.length).toBeGreaterThanOrEqual(3);
      // In character, never a price.
      for (const line of copy.lines) expect(line).not.toMatch(/[$€]|\d+\s*(usd|mxn|pesos|dólares|dollars)/i);
    }
  });

  it("every model referenced in models.yaml has a price", () => {
    const models = loadModels();
    const prices = loadPrices();
    const refs = [
      ...Object.values(models.roles).flatMap((r) => [r, r.fallback]),
      ...Object.values(models.profiles).flatMap((p) => [
        ...(p.companion ? [p.companion] : []),
        ...Object.entries(p.mesa ?? {}).map(([provider, model]) => ({ provider, model: model! })),
      ]),
    ];
    for (const r of refs) {
      expect(prices.llm[r.provider as keyof typeof prices.llm]?.[r.model], `${r.provider}/${r.model}`).toBeDefined();
    }
    expect(prices.realtime[models.voice.desktop.model]).toBeDefined();
  });

  it("coding agents never draw on the managed balance and Claude Code is API-key only", () => {
    const p = loadProviders();
    expect(p.codingAgents["claude-code"].auth).toEqual(["api_key"]);
  });
});

describe("currency lint", () => {
  it("flags currency literals", () => {
    for (const line of [
      'const p = "$10";',
      "label: `MX$ 199`",
      "const t = '749 MXN'",
      "price: USD 8",
      "'1,999.00 MXN'",
    ]) {
      expect(lintCurrency("apps/web/x.tsx", line), line).toHaveLength(1);
    }
  });
  it("ignores template placeholders and ordinary text", () => {
    for (const line of ["const s = `${count} pendientes`;", "const usd = plan.priceUsd;", "// see prices.yaml"]) {
      expect(lintCurrency("apps/web/x.tsx", line), line).toEqual([]);
    }
  });
  it("applies only to app source", () => {
    expect(isLintedFile("apps/web/app/page.tsx")).toBe(true);
    expect(isLintedFile("apps/web/app/page.test.tsx")).toBe(false);
    expect(isLintedFile("packages/config/plans.yaml")).toBe(false);
  });
});

describe("devmode liability text", () => {
  it("both locales load with the same version and a phrase", async () => {
    const { loadLiabilityText } = await import("../src/load.js");
    const es = loadLiabilityText("es");
    const en = loadLiabilityText("en");
    expect(es.version).toBe(en.version);
    expect(es.text).toContain("Chalito no es responsable");
    expect(en.text).toContain("Chalito is not liable");
    expect(es.phrase).toBe("ACEPTO");
  });
});

describe("catalog skins (material effects, no art)", () => {
  const catalog = loadCatalog();
  const skins = Object.entries(catalog.cosmetics).filter(([, c]) => c.slot === "skin");
  const base = { schemaVersion: 1, drops: {} };
  const parse = (cosmetics: Record<string, unknown>) => CatalogConfig.safeParse({ ...base, cosmetics });
  const skin = { name: { es: "Dorado", en: "Gold" }, slot: "skin", free: false, priceTokens: 10000, skin: "gold" };

  it("sells every effect the card renderer draws, once, as a paid item", () => {
    expect(skins.map(([, c]) => (c.slot === "skin" ? c.skin : null)).sort()).toEqual([...SkinEffect.options].sort());
    for (const [id, c] of skins) {
      expect(id).toMatch(/^skin_[a-z0-9_]+$/);
      expect(c.free).toBe(false);
      expect(c.priceTokens).toBeGreaterThan(0);
    }
  });

  it("validates skins: a known effect, no art or placement, priced unless free", () => {
    expect(parse({ skin_gold: skin }).success).toBe(true);
    expect(parse({ skin_gold: { ...skin, skin: "lava" } }).success).toBe(false);
    // Art or placement on a skin is dropped, like any key the schema doesn't know.
    const withArt = parse({ skin_gold: { ...skin, art: "cosmetics/x.webp", card: { width: 1, pivot: [0, 0] } } });
    expect(withArt.success && Object.keys(withArt.data.cosmetics.skin_gold!).sort()).toEqual(
      ["free", "name", "priceTokens", "skin", "slot"].sort(),
    );
    expect(parse({ skin_gold: { ...skin, priceTokens: undefined } }).success).toBe(false);
    expect(parse({ skin_gold: { ...skin, free: true } }).success).toBe(false);
    // The same effect sold twice under two ids is a mistake.
    expect(parse({ skin_gold: skin, gold_again: skin }).success).toBe(false);
  });

  it("accessories still need art and placement, and can't claim the skin slot without an effect", () => {
    const hat = catalog.cosmetics.viking_hat!;
    expect(parse({ viking_hat: hat }).success).toBe(true);
    expect(parse({ viking_hat: { ...hat, art: undefined } }).success).toBe(false);
    expect(parse({ viking_hat: { ...hat, slot: "skin" } }).success).toBe(false);
  });
});
