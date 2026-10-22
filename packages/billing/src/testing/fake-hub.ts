import { randomUUID } from "node:crypto";
import { HubAdmitRequest, HubSettle, HubUsageBatch } from "@chalito/protocol";
import { HUB_MARGIN_PERCENT } from "../reserve-basis.js";

/** The hub's ledger in memory, with admit_usage's rules (chalyb 0065): pass `fetch` to a HubClient. */
interface Reservation {
  id: string;
  user: string;
  jobId: string;
  cls: "job" | "stream";
  est: number;
  status: "open" | "succeeded" | "failed" | "cancelled" | "expired";
  expiresAt: number;
}

export class FakeHub {
  readonly users = new Map<string, { allocation: number; used: number; unlimited?: boolean }>();
  readonly reservations: Reservation[] = [];
  readonly events = new Map<string, { user: string; cost: number; billable: number; reservationId?: string }>();
  readonly calls: { path: string; body: unknown }[] = [];
  /** Per-user caps the hub applies to streams (TIER_CAPS activeStreams). */
  activeStreams = 5;
  down = false;
  marginPercent = HUB_MARGIN_PERCENT;

  constructor(private readonly now: () => number = Date.now) {}

  setUser(user: string, allocation: number) {
    this.users.set(user, { allocation, used: 0 });
  }

  /** What the hub has drawn for this user, in billable tokens. */
  used(user: string) {
    return this.users.get(user)?.used ?? 0;
  }

  #open(user: string) {
    const now = this.now();
    for (const r of this.reservations) if (r.status === "open" && r.expiresAt <= now) r.status = "expired";
    return this.reservations.filter((r) => r.user === user && r.status === "open");
  }

  remaining(user: string) {
    const u = this.users.get(user);
    if (!u) return 0;
    return u.allocation - u.used - this.#open(user).reduce((s, r) => s + r.est, 0);
  }

  #balance(user: string) {
    const u = this.users.get(user)!;
    return {
      remaining: Math.max(0, this.remaining(user)),
      unlimited: false,
      monthlyAllocation: u.allocation,
      bonus: 0,
      monthlyUsed: u.used,
      reserved: this.#open(user).reduce((s, r) => s + r.est, 0),
      periodStart: "2026-10-01T00:00:00.000Z",
    };
  }

  #admit(raw: unknown) {
    const b = HubAdmitRequest.parse(raw);
    const user = b.external_user_id;
    if (!this.users.has(user)) return { status: 404, body: { error: "unknown user_id" } };
    this.#open(user); // expires lapsed holds first
    const existing = this.reservations.find((r) => r.jobId === b.external_job_id);
    if (existing && existing.status !== "open")
      return { status: 200, body: { ok: true, allowed: false, reason: "already_settled" } };
    if (
      b.class === "stream" &&
      this.#open(user).filter((r) => r.cls === "stream" && r !== existing).length >= this.activeStreams
    )
      return { status: 200, body: { ok: true, allowed: false, reason: "concurrency" } };
    const est = Math.ceil(b.est_tokens * (1 + this.marginPercent / 100));
    const old = existing?.est ?? 0;
    if (existing) existing.est = 0; // re-admitting replaces the hold: release it before measuring
    if (this.remaining(user) < est) {
      if (existing) existing.est = old;
      return { status: 200, body: { ok: true, allowed: false, reason: "no_tokens" } };
    }
    const ttl = (b.ttl_seconds ?? 10_800) * 1000;
    let r = existing;
    if (r) Object.assign(r, { est, expiresAt: this.now() + ttl });
    else {
      r = {
        id: randomUUID(),
        user,
        jobId: b.external_job_id,
        cls: b.class,
        est,
        status: "open",
        expiresAt: this.now() + ttl,
      };
      this.reservations.push(r);
    }
    return {
      status: 200,
      body: {
        ok: true,
        allowed: true,
        reservation_id: r.id,
        lane: "standard",
        boost_fee_tokens: 0,
        limits: {},
        balance: this.#balance(user),
      },
    };
  }

  #usage(raw: unknown) {
    const b = HubUsageBatch.parse(raw);
    const u = this.users.get(b.external_user_id);
    if (!u) return { status: 404, body: { error: "unknown user_id" } };
    for (const e of b.events) {
      if (this.events.has(e.source_id)) continue; // (engine, source_id) is unique
      const billable = Math.max(1, Math.ceil((e.cost_usd_micros * (1 + this.marginPercent / 100)) / 4));
      this.events.set(e.source_id, {
        user: b.external_user_id,
        cost: e.cost_usd_micros,
        billable,
        ...(e.reservation_id ? { reservationId: e.reservation_id } : {}),
      });
      u.used += billable;
    }
    return { status: 200, body: { ok: true } };
  }

  #settle(raw: unknown) {
    const b = HubSettle.parse(raw);
    const r = this.reservations.find((x) => x.id === b.reservation_id);
    if (!r) return { status: 404, body: { error: "unknown reservation" } };
    if (b.outcome === "heartbeat") {
      if (r.status !== "open") return { status: 409, body: { error: "closed" } };
      return { status: 200, body: { ok: true } };
    }
    if (r.status === "open") r.status = b.outcome;
    return { status: 200, body: { ok: true } };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (this.down) return new Response("down", { status: 503 });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const path = url.pathname.replace(/^\/api\/engines\/chalito/, "");
    this.calls.push({ path, body });
    const r =
      path === "/usage/admit"
        ? this.#admit(body)
        : path === "/usage"
          ? this.#usage(body)
          : path === "/usage/settle"
            ? this.#settle(body)
            : path === "/usage/balance"
              ? { status: 200, body: { ok: true, balance: this.#balance(url.searchParams.get("external_user_id")!) } }
              : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
}
