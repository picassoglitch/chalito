import { randomUUID } from "node:crypto";
import { admitManaged, llmCostMicros, usageEvent, type HubClient, type OutOfEnergy } from "@chalito/billing";
import type { ModelsConfig, PricesConfig } from "@chalito/config";
import { fromB64url, sealJson } from "@chalito/crypto";
import {
  MesaTurn,
  type Entitlements,
  type MesaCard,
  type ParticipantOutput,
  type ParticipantRef,
} from "@chalito/protocol";
import type { Brain, BrainUsage } from "./brains/brain.js";
import { buildBrief, type BriefProfile, type RecentTurn } from "./core/brief.js";
import { checkBudget } from "./core/budget.js";
import { mergeCard } from "./core/card.js";
import type { MesaDoc, Participant, Speaker } from "./core/mesa.js";
import { moderate, type CheapModerator } from "./core/moderator.js";
import { resolveModel } from "./core/models.js";
import type { Source } from "./core/quote.js";
import type { MesaStore } from "./store.js";

/**
 * One Mesa turn (brief §5 M9, ADR 0013/0016): the person's input (or text they forward from an
 * MCP app or a room, which is quoted as data and never fans out) is stored sealed; the moderator
 * picks the addressed speakers; each one is admitted by the hub BEFORE any spend, called, and
 * its reply stored sealed to the person's clients together with its llm.tokens usage event
 * (outbox, same transaction). Out of energy: the turn finishes on free_min with the companion's
 * in-character recharge line. Nothing here can decide an approval.
 */
export interface TurnDeps {
  store: MesaStore;
  hub: Pick<HubClient, "admit" | "settle">;
  brain: Brain;
  models: ModelsConfig;
  prices: PricesConfig;
  entitlements: (owner: string) => Promise<Entitlements>;
  cheap?: CheapModerator;
  now: () => number;
  newId?: () => string;
  maxOutputTokens?: number;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

export type InputSource = "owner" | "mcp:claude" | "mcp:chatgpt" | "room";

export interface TurnRequest {
  owner: string;
  mid: string;
  /** Client-generated id of the input turn: a retried request is refused as a duplicate. */
  tid: string;
  text: string;
  source: InputSource;
  /** What the client holds (it can open the sealed history): the brief's goal, card, recent turns. */
  goal: string;
  card: MesaCard | null;
  recent: RecentTurn[];
  locale: "es" | "en";
}

export interface SpokenTurn {
  tid: string;
  pid: string;
  name: string;
  model: string;
  output: ParticipantOutput;
  usage: { in: number; out: number; cached: number };
  costUsdMicros: number;
}

export interface TurnResult {
  status: "ok" | "duplicate" | "not_found" | "closed" | "no_clients";
  turns: SpokenTurn[];
  card: MesaCard | null;
  /** The companion ran out of energy: the turn finished on free_min with this line and chip. */
  energy?: OutOfEnergy;
  /** Why the round stopped early, if it did. */
  stopped?: string;
  skipped: { pid: string; reason: string }[];
}

const refOf = (p: Participant, owner: string): ParticipantRef =>
  p.kind === "human"
    ? { kind: "human", uid: owner }
    : p.kind === "companion"
      ? { kind: "companion", companionId: p.companionId }
      : { kind: "brain", pid: p.pid, provider: p.provider, modelRef: p.modelRef };

const tokensOf = (u: BrainUsage) => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

export const costMicros = (prices: PricesConfig, model: string, u: BrainUsage) =>
  llmCostMicros(prices, "anthropic", model, {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite5m,
    cacheWriteTtl: "5m",
  }) +
  (u.cacheWrite1h > 0
    ? llmCostMicros(prices, "anthropic", model, {
        input: 0,
        output: 0,
        cacheWrite: u.cacheWrite1h,
        cacheWriteTtl: "1h",
      })
    : 0);

export const runTurn = async (d: TurnDeps, req: TurnRequest): Promise<TurnResult> => {
  const newId = d.newId ?? (() => `t_${randomUUID().replace(/-/g, "")}`);
  const result: TurnResult = { status: "ok", turns: [], card: req.card, skipped: [] };
  const mesa = await d.store.getMesa(req.owner, req.mid);
  if (!mesa) return { ...result, status: "not_found" };
  if (mesa.status !== "open") return { ...result, status: "closed", stopped: mesa.status };
  const keys = await d.store.clientBoxKeys(req.owner);
  if (Object.keys(keys).length === 0) return { ...result, status: "no_clients" };
  const recipients: Record<string, Uint8Array> = {};
  for (const [id, k] of Object.entries(keys)) recipients[id] = await fromB64url(k);
  const seal = (value: unknown) => sealJson(value, recipients, `mesa:${req.mid}`);

  const trusted = req.source === "owner";
  const addressed = await moderate({ text: req.text, trusted, participants: mesa.participants, cheap: d.cheap });
  const human = mesa.participants.find((p) => p.kind === "human");
  const ownerName = human?.name ?? (req.locale === "es" ? "Tú" : "You");

  // The input turn, sealed. A retry with the same tid stops here (no second spend).
  const inputDoc = {
    ...MesaTurn.parse({
      v: 1,
      mid: req.mid,
      tid: req.tid,
      speaker: { kind: "human", uid: req.owner },
      addressed: addressed.map((s) => refOf(s, req.owner)),
      outCt: await seal({ say: req.text, source: req.source }),
      usage: { in: 0, out: 0, cached: 0 },
      emotion: { tag: "neutral", intensity: 0 },
      t: d.now(),
    }),
    source: req.source,
  };
  if ((await d.store.appendTurn(req.owner, req.mid, req.tid, inputDoc)) === "duplicate")
    return { ...result, status: "duplicate" };

  const entitlements = await d.entitlements(req.owner);
  const profile = entitlements.efficiencyCurrent;
  const inputSource: Source = trusted ? "owner" : req.source;
  const recent: RecentTurn[] = [...req.recent];
  const input: RecentTurn = {
    speaker: trusted ? ownerName : `${ownerName} (reenvía)`,
    source: inputSource,
    text: req.text,
  };
  let doc: MesaDoc = mesa;

  for (const speaker of addressed) {
    const resolved = resolveModel(d.models, profile, speaker);
    const model = "model" in resolved ? resolved.model : null;
    // A provider without an adapter is skipped before anything is admitted (free_min still goes
    // through the gate below, for the in-character recharge line).
    if (!model && "unavailable" in resolved && resolved.unavailable !== "free_min") {
      result.skipped.push({ pid: speaker.pid, reason: resolved.unavailable });
      continue;
    }
    // Price check first: an unpriced model fails closed before anything is admitted or spent.
    if (model) costMicros(d.prices, model, { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    const brief = buildBrief({
      speaker,
      locale: req.locale,
      goal: req.goal,
      card: req.card,
      recent,
      input,
      profile: (profile === "free_min" ? "low" : profile) as BriefProfile,
      table: mesa.participants.map((p) => p.name),
    });
    const maxTokens = d.maxOutputTokens ?? 800;
    const estimate = brief.tokens + maxTokens;

    const budget = checkBudget(doc, speaker.pid, estimate);
    if (!budget.ok) {
      if (budget.scope === "mesa") {
        await d.store.setStatus(req.owner, req.mid, "budget_reached");
        result.stopped = "budget_mesa";
        break;
      }
      result.skipped.push({ pid: speaker.pid, reason: "budget_participant" });
      continue;
    }

    const gate = await admitManaged({
      hub: d.hub,
      entitlements,
      request: {
        external_user_id: req.owner,
        external_job_id: `mesa:${req.mid}:${req.tid}:${speaker.pid}`,
        class: "job",
        operation: speaker.kind === "companion" ? "companion.turn" : "mesa.turn",
        est_tokens: estimate,
      },
      locale: req.locale,
    });
    if (!gate.ok) {
      if ("outOfEnergy" in gate) {
        // Finish on free_min: the companion says it's tired, in character (no LLM call, no cost).
        const companion = mesa.participants.find((p): p is Speaker => p.kind === "companion") ?? speaker;
        const oe = gate.outOfEnergy;
        const output: ParticipantOutput = {
          say: oe.line,
          proposals: [],
          objections: [],
          emotion: { tag: "tired", intensity: 0.8 },
        };
        const tid = newId();
        await d.store.appendTurn(req.owner, req.mid, tid, {
          ...MesaTurn.parse({
            v: 1,
            mid: req.mid,
            tid,
            speaker: refOf(companion, req.owner),
            addressed: [],
            outCt: await seal(output),
            usage: { in: 0, out: 0, cached: 0 },
            emotion: output.emotion,
            t: d.now(),
          }),
          profile: "free_min",
          energy: { kind: oe.kind, animation: oe.animation, chip: oe.chip, presentation: oe.presentation },
        });
        result.energy = oe;
        result.turns.push({
          tid,
          pid: companion.pid,
          name: companion.name,
          model: "free_min",
          output,
          usage: { in: 0, out: 0, cached: 0 },
          costUsdMicros: 0,
        });
        result.stopped = "out_of_energy";
      } else {
        result.stopped = `refused:${gate.refused}`;
      }
      break;
    }
    if (!model) {
      // Admitted although the profile has no model (shouldn't happen): release, don't spend.
      await d.hub.settle({ reservation_id: gate.reservationId, outcome: "cancelled" }).catch(() => undefined);
      result.skipped.push({ pid: speaker.pid, reason: "unavailable" });
      continue;
    }

    let call;
    try {
      call = await d.brain.call({ model, persona: brief.persona, context: brief.context, maxTokens });
    } catch (err) {
      await d.hub.settle({ reservation_id: gate.reservationId, outcome: "failed" }).catch(() => undefined);
      d.log?.("mesa.brain_failed", {
        mid: req.mid,
        pid: speaker.pid,
        error: err instanceof Error ? err.message : "error",
      });
      result.skipped.push({ pid: speaker.pid, reason: "brain_error" });
      continue;
    }

    const u = call.usage;
    const cost = costMicros(d.prices, model, u);
    const tokens = tokensOf(u);
    const tid = newId();
    const usage = { in: u.input + u.cacheWrite5m + u.cacheWrite1h, out: u.output, cached: u.cacheRead };
    const event = usageEvent(
      {
        owner: req.owner,
        billingMode: "managed",
        origin: speaker.kind === "companion" ? "companion.turn" : "mesa.turn",
      },
      {
        kind: "llm.tokens",
        provider: "anthropic",
        amount: tokens,
        costUsdMicros: cost,
        occurredAt: d.now(),
        sourceId: `mesa.turn:${req.mid}:${tid}`,
        reservationId: gate.reservationId,
        metadata: {
          model,
          tokens: {
            input: u.input,
            output: u.output,
            cache_read: u.cacheRead,
            cache_write: u.cacheWrite5m + u.cacheWrite1h,
          },
        },
      },
    );
    const write = d.store.appendTurn(
      req.owner,
      req.mid,
      tid,
      {
        ...MesaTurn.parse({
          v: 1,
          mid: req.mid,
          tid,
          speaker: refOf(speaker, req.owner),
          addressed: [],
          outCt: await seal(call.output),
          usage,
          emotion: call.output.emotion,
          t: d.now(),
        }),
        model,
        profile,
        decisionNeeded: !!call.output.decision_needed,
      },
      { pid: speaker.pid, tokens, events: [event] },
    );
    try {
      await write;
    } catch (err) {
      // The turn and its usage commit together or not at all; release the reservation.
      await d.hub.settle({ reservation_id: gate.reservationId, outcome: "failed" }).catch(() => undefined);
      throw err;
    }
    await d.hub.settle({ reservation_id: gate.reservationId, outcome: "succeeded" }).catch(() => undefined);
    doc = {
      ...doc,
      used: {
        total: doc.used.total + tokens,
        byParticipant: {
          ...doc.used.byParticipant,
          [speaker.pid]: (doc.used.byParticipant[speaker.pid] ?? 0) + tokens,
        },
      },
    };
    result.turns.push({
      tid,
      pid: speaker.pid,
      name: speaker.name,
      model,
      output: call.output,
      usage,
      costUsdMicros: cost,
    });
    // Later speakers in this round hear it, as quoted data.
    recent.push({ speaker: speaker.name, source: `participant:${speaker.pid}`, text: call.output.say });
  }

  result.card = mergeCard(
    req.card,
    req.mid,
    req.goal,
    result.turns.filter((t) => t.model !== "free_min").map((t) => ({ pid: t.pid, name: t.name, output: t.output })),
  );
  return result;
};
