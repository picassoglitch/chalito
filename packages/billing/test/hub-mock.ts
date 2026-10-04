import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  checkAdmitRequest,
  checkBalanceRequest,
  checkBearer,
  checkSettleRequest,
  checkUsageRequest,
} from "./hub-contract.js";

/** The engine bearer every test client uses. */
export const HUB_TOKEN = "chalito-admin-token";
/**
 * The real hub's validation runs first (hub-contract.ts, copied from chalyb): a request the hub
 * would refuse gets the hub's status here too, before any simulated outcome.
 */
const refuse = (r: { status: number; error: string } | null) =>
  r ? HttpResponse.json({ error: r.error }, { status: r.status }) : null;

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
      balance: {
        remaining: 50_000,
        reserved: 1_000,
        unlimited: false,
        monthlyAllocation: 100_000,
        bonus: 0,
        monthlyUsed: 0,
        periodStart: "2026-10-01T00:00:00.000Z",
      },
    }),
    usageStatus: 200 as number | "network",
    balance: {
      ok: true,
      balance: {
        remaining: 42_000,
        reserved: 0,
        unlimited: false,
        monthlyAllocation: 100_000,
        bonus: 0,
        monthlyUsed: 58_000,
        periodStart: "2026-10-01T00:00:00.000Z",
      },
    } as Record<string, unknown>,
    balanceStatus: 200,
    admitStatus: 200,
    settleStatus: 200,
    token: HUB_TOKEN,
    /** The hub's clock, for occurred_at windows (tests set their own NOW). */
    now: () => Date.now(),
  };
  const base = "https://www.chalyb.com/api/engines/chalito";
  const server = setupServer(
    http.post(`${base}/usage/admit`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path: "admit", method: "POST", auth: request.headers.get("authorization"), body });
      const no = refuse(checkBearer(request.headers.get("authorization"), state.token) ?? checkAdmitRequest(body));
      if (no) return no;
      if (state.admitStatus !== 200)
        return HttpResponse.json({ error: "unknown user_id" }, { status: state.admitStatus });
      return HttpResponse.json(state.admit(body));
    }),
    http.post(`${base}/usage`, async ({ request }) => {
      const body = await request.json();
      calls.push({ path: "usage", method: "POST", auth: request.headers.get("authorization"), body });
      const no = refuse(
        checkBearer(request.headers.get("authorization"), state.token) ?? checkUsageRequest(body, state.now()),
      );
      if (no) return no;
      if (state.usageStatus === "network") return HttpResponse.error();
      return state.usageStatus === 200
        ? HttpResponse.json({ ok: true })
        : HttpResponse.json({ error: "x" }, { status: state.usageStatus });
    }),
    http.post(`${base}/usage/settle`, async ({ request }) => {
      const body = await request.json();
      calls.push({ path: "settle", method: "POST", auth: request.headers.get("authorization"), body });
      const no = refuse(checkBearer(request.headers.get("authorization"), state.token) ?? checkSettleRequest(body));
      if (no) return no;
      return state.settleStatus === 200
        ? HttpResponse.json({ ok: true })
        : HttpResponse.json({ ok: false, status: "succeeded" }, { status: state.settleStatus });
    }),
    http.get(`${base}/usage/balance`, ({ request }) => {
      calls.push({
        path: `balance?${new URL(request.url).searchParams}`,
        method: "GET",
        auth: request.headers.get("authorization"),
        body: null,
      });
      const no = refuse(
        checkBearer(request.headers.get("authorization"), state.token) ?? checkBalanceRequest(new URL(request.url)),
      );
      if (no) return no;
      return state.balanceStatus === 200
        ? HttpResponse.json(state.balance)
        : HttpResponse.json({ error: "unknown user_id" }, { status: state.balanceStatus });
    }),
  );
  return { server, calls, state };
};
