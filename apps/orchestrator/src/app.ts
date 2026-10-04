import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { Id, MesaCard, SealedEnvelope, SessionCard } from "@chalito/protocol";
import type { Authn, Caller } from "./auth.js";
import { processDecisions, type AuditFn } from "./decisions.js";
import { brainKeyAad, type KeyWrapper } from "./kms.js";
import type { OidcExpectation, OidcVerifier } from "./oidc.js";
import type { UsageRow } from "./store.js";
import { Participant, type MesaDoc } from "./core/mesa.js";
import type { RecentTurn } from "./core/brief.js";
import { runTurn, type TurnDeps } from "./turn.js";

/**
 * The orchestrator's HTTP surface (Cloud Run). Only an active client device of the owner can
 * create a Mesa or take a turn; it sends the plaintext it can see (its own text, or text it
 * forwards from an MCP app or a room) over TLS, and everything stored is sealed to its devices.
 */
export interface AppDeps extends TurnDeps {
  authn: Authn;
  /** Wraps BYO keys for cloud turns (Cloud KMS in production). */
  wrapper: KeyWrapper;
  audit: AuditFn;
  /** Cloud Scheduler → POST /tasks/sweep-decisions (Google OIDC). Absent: the route is off. */
  sweep?: { verify: OidcVerifier; expect: OidcExpectation };
  /** The web app's origin (CHALITO_WEB_ORIGIN), the only one browsers may call from. Absent: no CORS. */
  webOrigin?: string;
}

/**
 * CORS for the web app only: one exact origin (no wildcard), bearer auth (no cookies, so no
 * credentials), GET/POST/OPTIONS, a short preflight cache. Any other origin gets no
 * Access-Control-Allow-Origin, so browsers refuse to read the response.
 */
export const webCors = (webOrigin: string) => {
  const allowed = new URL(webOrigin).origin;
  return cors({
    origin: (origin) => (origin === allowed ? allowed : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    credentials: false,
    maxAge: 600,
  });
};

const CreateBody = z.object({
  /** Everyone but the person (added automatically). */
  participants: z.array(Participant).min(1).max(7),
  ownerName: z.string().min(1).max(40).optional(),
  budget: z
    .object({
      mesaTokens: z.number().int().positive().nullable().default(null),
      perParticipant: z.number().int().positive().nullable().default(null),
    })
    .default({ mesaTokens: null, perParticipant: null }),
});

const TurnBody = z.object({
  tid: Id,
  text: z.string().min(1).max(4000),
  source: z.enum(["owner", "mcp:claude", "mcp:chatgpt", "room"]).default("owner"),
  goal: z.string().max(400).default(""),
  card: MesaCard.nullable().default(null),
  recent: z
    .array(
      z.object({
        speaker: z.string().min(1).max(40),
        source: z.union([
          z.enum(["owner", "mcp:claude", "mcp:chatgpt", "room", "card"]),
          z.string().regex(/^participant:[A-Za-z0-9_-]{1,64}$/),
        ]),
        text: z.string().max(4000),
      }),
    )
    .max(3)
    .default([]),
  /** Cards of the Mesa's session participants, opened by this client (quoted as data). */
  sessionCards: z
    .array(z.object({ sid: Id, card: SessionCard }))
    .max(4)
    .default([]),
  locale: z.enum(["es", "en"]).default("es"),
});

const PROVIDERS = ["anthropic", "openai", "xai", "google"] as const;
const KeyBody = z
  .object({
    /** The key sealed to the person's own devices (aad brainkey:<owner>:<provider>). */
    sealedCt: SealedEnvelope,
    /** Opt in to cloud turns: then `key` is sent once, wrapped by KMS at once, never stored in plaintext. */
    cloud: z.boolean(),
    key: z.string().min(8).max(512).optional(),
    hint: z.string().max(8).default(""),
  })
  .refine((b) => b.cloud === (b.key !== undefined), { message: "key exactly when cloud" });

/** GET /v1/usage/daily: the usage page's read API (per day, managed vs BYO, work vs comms). */
export interface UsageDaily {
  days: {
    day: string;
    managed: { work: { tokens: number; costUsdMicros: number }; comms: { tokens: number; costUsdMicros: number } };
    byo: { tokens: number; estCostUsdMicros: number };
  }[];
  totals: { managedTokens: number; managedCostUsdMicros: number; commsCostUsdMicros: number; byoTokens: number };
  /** comms ÷ all managed cost (target < 0.10); null when nothing was spent. */
  commsOverheadRatio: number | null;
  target: 0.1;
}

export const summarizeUsage = (rows: UsageRow[], days: string[]): UsageDaily => {
  const blank = () => ({
    managed: { work: { tokens: 0, costUsdMicros: 0 }, comms: { tokens: 0, costUsdMicros: 0 } },
    byo: { tokens: 0, estCostUsdMicros: 0 },
  });
  const byDay = new Map(days.map((d) => [d, blank()]));
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    if (r.billing === "byo") {
      d.byo.tokens += r.tokens;
      d.byo.estCostUsdMicros += r.costUsdMicros;
    } else {
      d.managed[r.purpose].tokens += r.tokens;
      d.managed[r.purpose].costUsdMicros += r.costUsdMicros;
    }
  }
  const list = [...byDay].map(([day, v]) => ({ day, ...v }));
  const sum = (f: (x: (typeof list)[number]) => number) => list.reduce((a, x) => a + f(x), 0);
  const work = sum((x) => x.managed.work.costUsdMicros);
  const comms = sum((x) => x.managed.comms.costUsdMicros);
  return {
    days: list,
    totals: {
      managedTokens: sum((x) => x.managed.work.tokens + x.managed.comms.tokens),
      managedCostUsdMicros: work + comms,
      commsCostUsdMicros: comms,
      byoTokens: sum((x) => x.byo.tokens),
    },
    commsOverheadRatio: work + comms > 0 ? comms / (work + comms) : null,
    target: 0.1,
  };
};

type Env = { Variables: { caller: Caller } };

export const createOrchestrator = (deps: AppDeps) => {
  const app = new Hono<Env>();
  // Before auth: a preflight carries no Authorization header.
  if (deps.webOrigin) app.use("/v1/*", webCors(deps.webOrigin));
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Signed answers already rejected (audited once; never resolve anything later either).
  const rejected = new Set<string>();
  const decisions = (filter: { owner?: string; aid?: string }) =>
    processDecisions({ store: deps.store, now: deps.now, audit: deps.audit, rejected }, filter);

  /** Safety net for pokes that never came: every pending Mesa decision with signed answers. */
  app.post("/tasks/sweep-decisions", async (c) => {
    if (!deps.sweep) return c.text("not found", 404);
    if (!(await deps.sweep.verify(c.req.header("authorization"), deps.sweep.expect)))
      return c.json({ error: "unauthorized" }, 401);
    const r = await decisions({});
    return c.json({ resolved: r.resolved.length, invalid: r.invalid });
  });

  app.use("/v1/*", async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    let caller: Caller;
    try {
      caller = await deps.authn.verify(token);
    } catch {
      return c.json({ error: "unauthenticated" }, 401);
    }
    if (caller.role !== "client" || !caller.owner || !caller.deviceId) return c.json({ error: "forbidden" }, 403);
    if (!(await deps.store.activeClient(caller.owner, caller.deviceId)))
      return c.json({ error: "device_revoked" }, 403);
    c.set("caller", caller);
    await next();
  });

  app.post("/v1/mesas", async (c) => {
    const caller = c.get("caller");
    const b = CreateBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    const pids = new Set<string>();
    for (const p of b.data.participants) {
      if (p.kind === "human" || pids.has(p.pid)) return c.json({ error: "bad_participants" }, 400);
      pids.add(p.pid);
    }
    if (b.data.participants.filter((p) => p.kind === "session").length > 2)
      return c.json({ error: "bad_participants" }, 400);
    // Brains per Mesa come from the plan (limits.mesaBrains); unset fails closed.
    const limit = (await deps.entitlements(caller.owner)).limits.mesaBrains;
    const brains = b.data.participants.filter((p) => p.kind === "brain").length;
    if (typeof limit !== "number" || brains > limit) return c.json({ error: "mesa_brains_limit", limit }, 403);
    const mid = `m_${randomUUID().replace(/-/g, "")}`;
    const doc: MesaDoc = {
      v: 1,
      kind: "mesa",
      participants: [
        { kind: "human", pid: "owner", name: b.data.ownerName ?? "Tú", uid: caller.owner },
        ...b.data.participants,
      ],
      budget: b.data.budget,
      used: { total: 0, byParticipant: {} },
      status: "open",
      createdAt: deps.now(),
    };
    await deps.store.createMesa(caller.owner, mid, doc);
    return c.json({ mid }, 201);
  });

  app.post("/v1/mesas/:mid/turns", async (c) => {
    const caller = c.get("caller");
    const b = TurnBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    const r = await runTurn(deps, {
      owner: caller.owner,
      deviceId: caller.deviceId,
      mid: c.req.param("mid"),
      ...b.data,
      recent: b.data.recent as RecentTurn[],
    });
    const status = { ok: 200, duplicate: 409, not_found: 404, closed: 409, no_clients: 409 } as const;
    if (r.status !== "ok")
      return c.json({ error: r.status, ...(r.stopped ? { stopped: r.stopped } : {}) }, status[r.status]);
    return c.json(r, 200, { "cache-control": "no-store" });
  });

  // ---- Mesa decisions: the client pokes after inserting its signed Decision. The poke carries no
  // authority: the decision binds only if its signature verifies against the signer's key.
  app.post("/v1/decisions/:aid/check", async (c) => {
    const aid = Id.safeParse(c.req.param("aid"));
    if (!aid.success) return c.json({ error: "bad_request" }, 400);
    const r = await decisions({ owner: c.get("caller").owner, aid: aid.data });
    const done = r.resolved.find((x) => x.aid === aid.data);
    return c.json({ aid: aid.data, status: done?.status ?? "pending" });
  });

  // ---- BYO brain keys (the person's own provider keys)
  app.put("/v1/brain-keys/:provider", async (c) => {
    const caller = c.get("caller");
    const provider = z.enum(PROVIDERS).safeParse(c.req.param("provider"));
    const b = KeyBody.safeParse(await c.req.json().catch(() => null));
    if (!provider.success || !b.success) return c.json({ error: "bad_request" }, 400);
    const wrapped = b.data.key ? await deps.wrapper.wrap(b.data.key, brainKeyAad(caller.owner, provider.data)) : null;
    await deps.store.putBrainKey(
      caller.owner,
      {
        provider: provider.data,
        sealedCt: b.data.sealedCt,
        hint: b.data.key ? b.data.key.slice(-4) : b.data.hint.slice(-4),
        cloud: wrapped !== null,
      },
      wrapped,
    );
    return c.body(null, 204);
  });
  app.delete("/v1/brain-keys/:provider", async (c) => {
    const provider = z.enum(PROVIDERS).safeParse(c.req.param("provider"));
    if (!provider.success) return c.json({ error: "bad_request" }, 400);
    const gone = await deps.store.deleteBrainKey(c.get("caller").owner, provider.data);
    return gone ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  // ---- usage page (read API)
  app.get("/v1/usage/daily", async (c) => {
    const n = Math.min(31, Math.max(1, Number(c.req.query("days") ?? 30) || 30));
    const DAY = 86_400_000;
    const today = Math.floor(deps.now() / DAY) * DAY;
    const days = Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY).toISOString().slice(0, 10));
    const rows = await deps.store.usageDaily(c.get("caller").owner, today - (n - 1) * DAY);
    return c.json(summarizeUsage(rows, days), 200, { "cache-control": "no-store" });
  });

  app.onError((err, c) => {
    console.error("[orchestrator] unhandled", err instanceof Error ? err.message : "error");
    return c.json({ error: "internal" }, 500);
  });
  return app;
};
