import { describe, expect, it } from "vitest";
import { loadCatalog, loadModels, loadPlans, loadPrices, loadProviders, loadRender, loadRooms } from "../src/load.js";
import { isLintedFile, lintCurrency } from "../src/currency.js";

describe("config files", () => {
  it("every config file loads and validates", () => {
    expect(loadPlans().tiers.lite?.priceUsd).toBe(10);
    expect(loadModels().vertex.location).toBe("global");
    expect(loadPrices().llm.google["gemini-3.1-flash-lite"]?.input).toBe(0.25);
    expect(loadProviders().providers.anthropic.subscriptionLocal).toBe("off");
    expect(loadRooms().defaults.ephemeralTtl).toBe("PT24H");
    expect(loadRender().default).toBe("auto");
    expect(loadCatalog().cosmetics.viking_hat?.free).toBe(true);
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
