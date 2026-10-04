import { describe, expect, it } from "vitest";
import { httpUsage, parseUsage } from "@/lib/usage";

const day = (d: string, work: number, comms: number, byo = 0) => ({
  day: d,
  managed: {
    work: { tokens: work, costUsdMicros: work * 2 },
    comms: { tokens: comms, costUsdMicros: comms * 2 },
  },
  byo: { tokens: byo, estCostUsdMicros: byo * 2 },
});

/** The orchestrator's response (apps/orchestrator summarizeUsage). */
const body = {
  days: [day("2026-10-01", 1000, 50, 300), day("2026-10-02", 0, 0)],
  totals: { managedTokens: 1050, managedCostUsdMicros: 2100, commsCostUsdMicros: 100, byoTokens: 300 },
  commsOverheadRatio: 100 / 2100,
  target: 0.1,
};

describe("usage (GET /v1/usage/daily)", () => {
  it("keeps tokens and shares, drops every cost", () => {
    const u = parseUsage(body)!;
    expect(u.totals).toEqual({ managedTokens: 1050, byoTokens: 300 });
    expect(u.days[0]).toEqual({
      day: "2026-10-01",
      managed: { work: { tokens: 1000 }, comms: { tokens: 50 } },
      byo: { tokens: 300 },
      commsShare: 100 / 2100,
    });
    expect(u.days[1]!.commsShare).toBeNull();
    expect(u.target).toBe(0.1);
    expect(JSON.stringify(u)).not.toMatch(/cost/i);
  });

  it("refuses malformed bodies instead of showing zeros", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage({ ...body, days: [{ ...day("2026-10-01", 1, 1), day: "yesterday" }] })).toBeNull();
    expect(parseUsage({ ...body, days: [day("2026-10-01", -1, 0)] })).toBeNull();
    expect(parseUsage({ ...body, commsOverheadRatio: 3 })).toBeNull();
    expect(parseUsage({ ...body, totals: {} })).toBeNull();
    expect(parseUsage({ ...body, commsOverheadRatio: null })!.commsOverheadRatio).toBeNull();
  });

  it("asks the orchestrator with this device's bearer, clamps days, and maps failures to error", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const api = httpUsage("https://orch.example", async () => "dev-token", ok);
    expect(await api(90)).not.toBe("error");
    expect(seen[0]).toEqual({ url: "https://orch.example/v1/usage/daily?days=31", auth: "Bearer dev-token" });

    const status = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    expect(await httpUsage("https://orch.example", async () => "t", status)(7)).toBe("error");
    const offline = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await httpUsage("https://orch.example", async () => "t", offline)(7)).toBe("error");
    expect(await httpUsage("https://orch.example", async () => null, ok)(7)).toBe("error");
    expect(seen).toHaveLength(1);
  });
});
