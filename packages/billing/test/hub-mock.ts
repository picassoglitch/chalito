import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

/** The Chalyb hub, mocked at the HTTP layer. `respond` can be swapped per test. */
export const hubMock = () => {
  const calls: { path: string; method: string; auth: string | null; body: unknown }[] = [];
  const state = {
    admit: (_body: Record<string, unknown>): Record<string, unknown> => ({
      ok: true,
      allowed: true,
      reservation_id: "11111111-1111-4111-8111-111111111111",
      lane: "standard",
      boost_fee_tokens: 0,
      limits: {},
      balance: { remaining: 50_000, reserved: 1_000 },
    }),
    usageStatus: 200 as number | "network",
    balance: { remaining: 42_000, reserved: 0 } as Record<string, unknown>,
  };
  const base = "https://www.chalyb.com/api/engines/chalito";
  const server = setupServer(
    http.post(`${base}/usage/admit`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path: "admit", method: "POST", auth: request.headers.get("authorization"), body });
      return HttpResponse.json(state.admit(body));
    }),
    http.post(`${base}/usage`, async ({ request }) => {
      const body = await request.json();
      calls.push({ path: "usage", method: "POST", auth: request.headers.get("authorization"), body });
      if (state.usageStatus === "network") return HttpResponse.error();
      return state.usageStatus === 200
        ? HttpResponse.json({ ok: true })
        : HttpResponse.json({ error: "x" }, { status: state.usageStatus });
    }),
    http.post(`${base}/usage/settle`, async ({ request }) => {
      calls.push({
        path: "settle",
        method: "POST",
        auth: request.headers.get("authorization"),
        body: await request.json(),
      });
      return HttpResponse.json({ ok: true });
    }),
    http.get(`${base}/usage/balance`, ({ request }) => {
      calls.push({
        path: `balance?${new URL(request.url).searchParams}`,
        method: "GET",
        auth: request.headers.get("authorization"),
        body: null,
      });
      return HttpResponse.json(state.balance);
    }),
  );
  return { server, calls, state };
};
