import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEV_CATALOG } from "@/dev/catalog";
import { httpStore, newPurchaseId, parseCatalog, readCompanion } from "@/lib/store";

const item = {
  id: "star_cape",
  name: { es: "Capa de estrellas", en: "Star cape" },
  slot: "back",
  free: false,
  priceTokens: 250000,
  art: "cosmetics/star_cape.webp",
  card: { width: 0.72, pivot: [0.5, 0.12] },
  owned: false,
};

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("store (/v1/store)", () => {
  it("the mock serves exactly packages/config/catalog.yaml (minus the server-only fields)", () => {
    const yaml = parse(readFileSync(resolve(process.cwd(), "../../packages/config/catalog.yaml"), "utf8")) as {
      cosmetics: Record<string, Record<string, unknown>>;
    };
    const fromYaml = Object.fromEntries(
      Object.entries(yaml.cosmetics).map(([id, { vrm: _v, provenance: _p, ...x }]) => [id, x]),
    );
    expect(JSON.parse(JSON.stringify(DEV_CATALOG))).toEqual(fromYaml);
  });

  it("parses the catalog strictly (prices in tokens, art inside the roster)", () => {
    expect(parseCatalog({ items: [item] })).toEqual([item]);
    expect(parseCatalog({ items: [{ ...item, priceTokens: undefined }] })).toBeNull();
    expect(parseCatalog({ items: [{ ...item, art: "https://evil.example/x.webp" }] })).toBeNull();
    expect(parseCatalog({ items: [{ ...item, slot: "feet" }] })).toBeNull();
    expect(parseCatalog({})).toBeNull();
    const free = parseCatalog({ items: [{ ...item, free: true, priceTokens: undefined }] })!;
    expect(free[0]).not.toHaveProperty("priceTokens");
  });

  it("purchase: owned, no_tokens chip (same-site only), retryable failures, the rest failed", async () => {
    const api = (f: typeof fetch) => httpStore("https://api.example", async () => "tok", f);
    expect(await api(respond(200, { status: "owned", charged: 250000 })).purchase("star_cape", "p".repeat(16))).toEqual(
      {
        ok: true,
        charged: 250000,
      },
    );
    expect(
      await api(respond(402, { error: "no_tokens", chips: [{ href: "/creditos" }] })).purchase("x", "p".repeat(16)),
    ).toEqual({ ok: false, reason: "no_tokens", chipHref: "/creditos" });
    for (const href of ["https://evil.example", "//evil.example", "/\\evil.example"])
      expect(
        await api(respond(402, { error: "no_tokens", chips: [{ href }] })).purchase("x", "p".repeat(16)),
      ).toMatchObject({ chipHref: "/creditos" });
    expect(await api(respond(503, { error: "hub_unavailable" })).purchase("x", "p".repeat(16))).toEqual({
      ok: false,
      reason: "retry",
    });
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await api(offline).purchase("x", "p".repeat(16))).toEqual({ ok: false, reason: "retry" });
    expect(await api(respond(409, { error: "purchase_id_conflict" })).purchase("x", "p".repeat(16))).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("equip errors map to what the page says", async () => {
    const api = (status: number, error: string) =>
      httpStore("https://api.example", async () => "tok", respond(status, { error }));
    expect(await api(403, "not_owned").equip("chl_x", "back", "star_cape")).toEqual({ ok: false, reason: "not_owned" });
    expect(await api(400, "wrong_slot").equip("chl_x", "head", "star_cape")).toEqual({
      ok: false,
      reason: "wrong_slot",
    });
    expect(await api(404, "unknown_companion").equip("chl_x", "back", null)).toEqual({
      ok: false,
      reason: "no_companion",
    });
  });

  it("sends the bearer and JSON; nothing without a session", async () => {
    const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    await httpStore("https://api.example", async () => "tok", f).equip("chl_x", "back", null);
    expect(seen).toEqual([
      {
        url: "https://api.example/v1/store/equip",
        method: "POST",
        auth: "Bearer tok",
        body: { companionId: "chl_x", slot: "back", cosmeticId: null },
      },
    ]);
    expect(await httpStore("https://api.example", async () => null, f).catalog()).toBe("error");
    expect(seen).toHaveLength(1);
  });

  it("purchase ids fit the api's pattern and differ per tap", () => {
    const a = newPurchaseId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(newPurchaseId()).not.toBe(a);
  });

  it("reads the companion's look, keeping only known slots", async () => {
    const db = (data: unknown, error: unknown = null) => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }),
    });
    expect(
      await readCompanion(
        db({ companion_id: "chl_x", avatar: "luna", equipped: { head: "viking_hat", tail: "x", face: 3 } }),
        "o",
      ),
    ).toEqual({ companionId: "chl_x", avatar: "luna", equipped: { head: "viking_hat" } });
    expect(await readCompanion(db(null), "o")).toBeNull();
    expect(await readCompanion(db(null, { message: "rls" }), "o")).toBe("error");
  });
});
