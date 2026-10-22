import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  CODING_PROVIDER,
  DEFAULT_TZ,
  HubUnavailable,
  capTz,
  codingDailyCap,
  codingHoldRequest,
  codingWorstCaseMicros,
  hubTierOf,
  localDayKey,
  reserveTokens,
  type CapZone,
  type CodingAgent,
  type CodingMeter,
  type HubClient,
  type ReserveBasis,
} from "@chalito/billing";
import type { PricesConfig, ProvidersConfig } from "@chalito/config";
import { errorMessage } from "@chalito/redact";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import { verifyStepUp } from "../lib/step-up.js";
import { webauthnConfigFromEnv, type WebAuthnConfig } from "../routes/webauthn.js";
import type { CodingIssueStore } from "./store.js";

export interface CodingDeps {
  store: CodingIssueStore;
  hub: Pick<HubClient, "admit" | "settle">;
  /** Closes a revoked credential's hold right away (the ai-gateway's sweep is the backstop). */
  meter: Pick<CodingMeter, "settle">;
  prices: PricesConfig;
  providers: ProvidersConfig;
  /** sessions.yaml maxLivePerDevice: live managed credentials per device. */
  maxLivePerDevice: number;
  reserveBasis: ReserveBasis;
  /** CODING_MANAGED_ENABLED=1, read on every request so the switch needs no redeploy of this code. */
  enabled: () => boolean;
  /** The ai-gateway's public base URL (CHALITO_AI_GATEWAY_URL). */
  gatewayUrl: string;
}

const MANAGED_AGENTS = ["codex", "gemini-cli", "grok-build"] as const;
const Issue = z.object({
  sid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  agent: z.string().max(40),
});
const Cap = z.object({ dailyCapTokens: z.number().int().min(0).max(1e11), stepUp: z.unknown().optional() });

const newToken = () => `chc_${randomBytes(32).toString("base64url")}`;
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** ADR 0030: per-session credentials for "IA de Chalyb" coding agents, and the owner's daily cap. */
export const codingRoutes = (deps: Deps, coding: CodingDeps, wa: WebAuthnConfig = webauthnConfigFromEnv()) => {
  const app = new Hono<AuthEnv>();
  const cfg = coding.providers.codingManaged;
  // Frees the hub's stream slot now instead of at the next sweep (Pro has one).
  const settleNow = (id: string) =>
    coding.meter.settle(id).catch((err: unknown) => console.error("[coding] settle failed", id, errorMessage(err)));
  const eligible = (tier: string | null) => {
    const t = hubTierOf(tier);
    return t !== null && (cfg.tiers as string[]).includes(t);
  };
  const spentToday = async (owner: string, zone: CapZone, now: number) => {
    const day = localDayKey(now, capTz(zone, now));
    return (await coding.store.spend(owner, day))
      .filter((r) => r.day === day)
      .reduce((s, r) => s + r.billableTokens, 0);
  };

  // The agent, at session start: the token is answered once and never stored or logged in clear.
  app.post("/credentials", requireAuth(deps, ["agent"]), async (c) => {
    const p = principal(c);
    if (!coding.enabled()) return fail(503, "managed_disabled");
    const body = Issue.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    if (!(MANAGED_AGENTS as readonly string[]).includes(body.data.agent)) return fail(400, "not_managed");
    const agent = body.data.agent as CodingAgent;
    const managed = coding.providers.codingAgents[agent]?.managed;
    if (!managed) return fail(400, "not_managed");
    const now = deps.now();
    const o = await coding.store.owner(p.owner);
    if (!o || !eligible(o.tier)) return fail(403, "not_eligible");
    if (
      (await coding.store.liveOnDevice(p.owner, p.deviceId!, now, { sid: body.data.sid, agent })) >=
      coding.maxLivePerDevice
    )
      return fail(429, "session_limit");
    if ((await spentToday(p.owner, o.capZone, now)) >= codingDailyCap(cfg, o.tier, o.capTokens))
      return fail(402, "daily_cap");

    const id = `cc_${randomBytes(16).toString("hex")}`;
    const provider = CODING_PROVIDER[agent];
    // The first request's worst case at a full window; every request tops the hold up again.
    const est = reserveTokens(
      codingWorstCaseMicros(coding.prices, provider, {
        model: managed.defaultModel,
        inputBytes: managed.maxInputTokens,
        maxInputTokens: managed.maxInputTokens,
        maxOutputTokens: managed.maxOutputTokens,
      }),
      coding.reserveBasis,
    );
    let admit;
    try {
      admit = await coding.hub.admit(codingHoldRequest({ id, owner: p.owner }, 0, est, cfg.holdTtlSeconds));
    } catch (err) {
      if (!(err instanceof HubUnavailable)) console.error("[coding] admit failed", errorMessage(err));
      return fail(503, "hub_unavailable");
    }
    if (!admit.allowed)
      return admit.reason === "no_tokens" ? fail(402, "out_of_energy") : fail(429, "managed_busy", admit.reason);
    const token = newToken();
    const expiresAt = now + cfg.credentialTtlSeconds * 1000;
    const cancel = (why: string) =>
      coding.hub
        .settle({ reservation_id: admit.reservation_id, outcome: "cancelled" })
        .catch((err: unknown) =>
          console.error("[coding] hold not cancelled", why, admit.reservation_id, errorMessage(err)),
        );
    let issued: Awaited<ReturnType<CodingDeps["store"]["issue"]>>;
    try {
      issued = await coding.store.issue(
        {
          id,
          tokenHash: sha256hex(token),
          owner: p.owner,
          deviceId: p.deviceId!,
          sid: body.data.sid,
          agent,
          provider,
          models: managed.models,
          reservationId: admit.reservation_id,
          createdAt: now,
          expiresAt,
        },
        coding.maxLivePerDevice,
      );
    } catch (err) {
      await cancel("issue_failed");
      throw err;
    }
    if (issued.result === "limit") {
      // Lost the race for the device's last slot: give the hold back.
      await cancel("session_limit");
      return fail(429, "session_limit");
    }
    for (const old of issued.replaced) await settleNow(old);
    await deps.audit.record({
      action: "coding.credential_issued",
      owner: p.owner,
      actor: p.uid,
      target: id,
      meta: { agent, sid: body.data.sid, deviceId: p.deviceId },
    });
    c.header("cache-control", "no-store");
    return c.json(
      {
        id,
        token,
        baseUrl: coding.gatewayUrl,
        agent,
        provider,
        models: managed.models,
        defaultModel: managed.defaultModel,
        expiresAt,
      },
      201,
    );
  });

  // After a turn: is the session's credential still good, or blocked (out of tokens, over the cap)?
  app.get("/credentials/:id", requireAuth(deps, ["agent"]), async (c) => {
    const p = principal(c);
    const v = await coding.store.get(p.owner, p.deviceId!, c.req.param("id"));
    if (!v) return fail(404, "not_found");
    const state = v.revokedAt !== null ? "revoked" : v.expiresAt <= deps.now() ? "expired" : "active";
    return c.json({ id: v.id, state, blockedReason: v.blockedReason, revokedReason: v.revokedReason });
  });

  // Session end. The gateway's sweep settles the hold within a minute.
  app.delete("/credentials/:id", requireAuth(deps, ["agent"]), async (c) => {
    const p = principal(c);
    const id = c.req.param("id");
    if (!(await coding.store.get(p.owner, p.deviceId!, id))) return fail(404, "not_found");
    await coding.store.revoke(p.owner, p.deviceId!, id, "session_end", deps.now());
    await settleNow(id);
    return c.json({ ok: true });
  });

  app.get("/settings", requireAuth(deps, ["user", "client"]), async (c) => {
    const p = principal(c);
    const now = deps.now();
    const o = await coding.store.owner(p.owner);
    const tier = hubTierOf(o?.tier ?? null);
    const tz = o ? capTz(o.capZone, now) : DEFAULT_TZ;
    const from = localDayKey(now - 29 * 86_400_000, tz);
    const days = await coding.store.spend(p.owner, from);
    const today = localDayKey(now, tz);
    c.header("cache-control", "private, no-store");
    return c.json({
      enabled: coding.enabled(),
      eligible: !!o && eligible(o.tier),
      tier,
      agents: MANAGED_AGENTS,
      dailyCapTokens: codingDailyCap(cfg, o?.tier ?? null, o?.capTokens ?? null),
      defaultCapTokens: cfg.dailyCap.default,
      ceilingTokens: tier === "pro" || tier === "vip" ? (cfg.dailyCap.ceiling[tier] ?? 0) : 0,
      today: {
        day: today,
        billableTokens: days.filter((d) => d.day === today).reduce((s, d) => s + d.billableTokens, 0),
      },
      days,
    });
  });

  // Lowering is free; raising needs the passkey on this device (the hub's client) and stops at the ceiling.
  app.post("/settings", requireAuth(deps, ["user", "client"]), async (c) => {
    const p = principal(c);
    const body = Cap.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const o = await coding.store.owner(p.owner);
    if (!o || !eligible(o.tier)) return fail(403, "not_eligible");
    const tier = hubTierOf(o.tier) as "pro" | "vip";
    const want = body.data.dailyCapTokens;
    if (want > (cfg.dailyCap.ceiling[tier] ?? 0)) return fail(400, "above_ceiling");
    const current = codingDailyCap(cfg, o.tier, o.capTokens);
    if (want > current) {
      if (p.role !== "client" || !p.deviceId) return fail(403, "step_up_required");
      const step = await verifyStepUp(deps, wa, {
        owner: p.owner,
        uid: p.uid,
        deviceId: p.deviceId,
        stepUp: body.data.stepUp,
        during: "coding.cap_raise",
      });
      if (!step.ok) return fail(step.status, step.error);
    }
    await coding.store.setCap(p.owner, want, deps.now());
    await deps.audit.record({
      action: "coding.cap_changed",
      owner: p.owner,
      actor: p.uid,
      meta: { from: current, to: want, stepUp: want > current },
    });
    return c.json({ ok: true, dailyCapTokens: want });
  });

  return app;
};
