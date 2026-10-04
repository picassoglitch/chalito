import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { Id, MesaCard } from "@chalito/protocol";
import type { Authn, Caller } from "./auth.js";
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
}

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
  locale: z.enum(["es", "en"]).default("es"),
});

type Env = { Variables: { caller: Caller } };

export const createOrchestrator = (deps: AppDeps) => {
  const app = new Hono<Env>();
  app.get("/healthz", (c) => c.json({ ok: true }));

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
      mid: c.req.param("mid"),
      ...b.data,
      recent: b.data.recent as RecentTurn[],
    });
    const status = { ok: 200, duplicate: 409, not_found: 404, closed: 409, no_clients: 409 } as const;
    if (r.status !== "ok")
      return c.json({ error: r.status, ...(r.stopped ? { stopped: r.stopped } : {}) }, status[r.status]);
    return c.json(r, 200, { "cache-control": "no-store" });
  });

  app.onError((err, c) => {
    console.error("[orchestrator] unhandled", err instanceof Error ? err.message : "error");
    return c.json({ error: "internal" }, 500);
  });
  return app;
};
