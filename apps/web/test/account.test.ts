import { describe, expect, it } from "vitest";
import { httpAccount, parseStatus, timeLeft } from "@/lib/account";

const DAY = 86_400_000;

/** A fetch that answers from a table of `METHOD path` → [status, body], and records calls. */
const fake = (routes: Record<string, [number, unknown]>) => {
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const [status, body] = routes[`${method} ${url.pathname}`] ?? [404, { error: "not_found" }];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { f, calls };
};

describe("account (lib/account.ts)", () => {
  it("parses the deletion status and refuses malformed ones", () => {
    expect(parseStatus({ status: "none" })).toEqual({ status: "none" });
    expect(parseStatus({ status: "scheduled", requestedAt: 1, dueAt: 2 })).toEqual({
      status: "scheduled",
      requestedAt: 1,
      dueAt: 2,
    });
    expect(parseStatus({ status: "scheduled" })).toBeNull();
    expect(parseStatus({ status: "weird", requestedAt: 1, dueAt: 2 })).toBeNull();
    expect(parseStatus(null)).toBeNull();
  });

  it("counts down in days and hours, to the nearest hour, never negative", () => {
    expect(timeLeft(7 * DAY, 0)).toEqual({ days: 7, hours: 0 });
    expect(timeLeft(7 * DAY, -60_000)).toEqual({ days: 7, hours: 0 });
    expect(timeLeft(7 * DAY, 1)).toEqual({ days: 7, hours: 0 });
    expect(timeLeft(7 * DAY, 3_600_000)).toEqual({ days: 6, hours: 23 });
    expect(timeLeft(0, 5)).toEqual({ days: 0, hours: 0 });
  });

  it("requests with the step-up, as the bearer, and maps the api's errors", async () => {
    const ok = fake({ "POST /v1/account/deletion": [202, { status: "scheduled", dueAt: 99, exportReady: true }] });
    const api = httpAccount("https://api.test", async () => "tok", ok.f);
    expect(await api.request({ id: "a" })).toEqual({ ok: true, dueAt: 99 });
    expect(ok.calls[0]).toEqual({
      method: "POST",
      path: "/v1/account/deletion",
      auth: "Bearer tok",
      body: { stepUp: { id: "a" } },
    });
    const cases: [number, string, string][] = [
      [403, "passkey_required", "passkey_required"],
      [401, "step_up_required", "passkey_required"],
      [401, "step_up_failed", "step_up_failed"],
      [403, "authenticator_cloned", "step_up_failed"],
      [409, "already_scheduled", "already_scheduled"],
      [500, "boom", "failed"],
    ];
    for (const [status, error, reason] of cases) {
      const f = fake({ "POST /v1/account/deletion": [status, { error }] });
      expect(await httpAccount("https://api.test", async () => "tok", f.f).request({}), error).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it("status, cancel and export", async () => {
    const f = fake({
      "GET /v1/account/deletion": [200, { status: "scheduled", requestedAt: 1, dueAt: 2 }],
      "DELETE /v1/account/deletion": [200, { status: "cancelled" }],
      "GET /v1/account/export": [200, { owner: "o" }],
    });
    const api = httpAccount("https://api.test", async () => "tok", f.f);
    expect(await api.status()).toEqual({ status: "scheduled", requestedAt: 1, dueAt: 2 });
    expect(await api.cancel()).toBe("ok");
    const blob = await api.export();
    expect(typeof blob).toBe("object");
    expect(JSON.parse(await (blob as Blob).text())).toEqual({ owner: "o" });

    const none = httpAccount("https://api.test", async () => "tok", fake({}).f);
    expect(await none.cancel()).toBe("nothing_scheduled");
    expect(await none.export()).toBe("none");
    expect(await none.status()).toBe("error");
  });

  it("does nothing without a bearer or a base", async () => {
    const f = fake({});
    expect(await httpAccount("https://api.test", async () => null, f.f).status()).toBe("error");
    expect(await httpAccount("", async () => "tok", f.f).request({})).toEqual({ ok: false, reason: "failed" });
    expect(f.calls).toEqual([]);
  });
});
