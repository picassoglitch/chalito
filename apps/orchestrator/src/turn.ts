import { errorMessage } from "@chalito/redact";
import { randomUUID } from "node:crypto";
import {
  admitManaged,
  llmCostMicros,
  reserveTokens,
  usageEvent,
  type HubClient,
  type OutOfEnergy,
  type ReserveBasis,
} from "@chalito/billing";
import type { ModelsConfig, PricesConfig } from "@chalito/config";
import { fromB64url, sealJson } from "@chalito/crypto";
import {
  MesaTurn,
  type Entitlements,
  type MesaCard,
  type ParticipantOutput,
  type ParticipantRef,
  type SessionCard,
} from "@chalito/protocol";
import type { Brain, BrainProviderId, BrainUsage } from "./brains/brain.js";
import { buildBrief, type BriefProfile, type RecentTurn } from "./core/brief.js";
import { checkBudget } from "./core/budget.js";
import { mergeCard } from "./core/card.js";
import type { MesaDoc, Participant, Speaker } from "./core/mesa.js";
import { moderate, type CheapModerator } from "./core/moderator.js";
import { providerFor, resolveModel } from "./core/models.js";
import type { Source } from "./core/quote.js";
import type { MesaStore } from "./store.js";

/**
 * One Mesa turn (brief §5 M9, ADR 0013/0016).
 *
 * The person's input (or text they forward from an MCP app or a room, quoted as data and never
 * fanned out) is stored sealed; the moderator picks the addressed speakers; for each:
 *  - BYO: the person's own provider key (cloud opt-in) → no hub admission, no billable event,
 *    but the Mesa's budget caps still apply;
 *  - managed: priced model or fail closed → budget caps → `admitManaged` BEFORE any spend →
 *    the call → the sealed reply + its llm.tokens outbox event + counters in one transaction.
 * Out of energy: the companion's in-character recharge line on free_min (once); BYO speakers
 * still talk. A participant asking for a decision raises a pending `kind=decision` approval for
 * the person to sign; nothing here can decide or resolve one. Session participants are only
 * quoted (their card); nothing here can prompt a session.
 */
export interface Brains {
  /** Chalito's managed keys, per configured provider. */
  managed: Partial<Record<BrainProviderId, Brain>>;
  /** A brain on the person's own key when they opted in to cloud turns for that provider. */
  byo?: (owner: string, provider: BrainProviderId) => Promise<Brain | null>;
}

export interface TurnDeps {
  store: MesaStore;
  hub: Pick<HubClient, "admit" | "settle">;
  brains: Brains;
  models: ModelsConfig;
  prices: PricesConfig;
  /** What est_tokens means at this hub (HUB_RESERVE_BASIS). */
  reserveBasis: ReserveBasis;
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
  /** The client device taking the turn (origin of any decision it leads to). */
  deviceId: string;
  mid: string;
  /** Client-generated id of the input turn: a retried request is refused as a duplicate. */
  tid: string;
  text: string;
  source: InputSource;
  /** What the client holds (it can open the sealed history): the brief's goal, card, recent turns. */
  goal: string;
  card: MesaCard | null;
  recent: RecentTurn[];
  /** Cards of the Mesa's session participants, opened by the client. */
  sessionCards?: { sid: string; card: SessionCard }[];
  locale: "es" | "en";
}

export interface SpokenTurn {
  tid: string;
  pid: string;
  name: string;
  provider: BrainProviderId | "none";
  model: string;
  billing: "managed" | "byo" | "free_min";
  output: ParticipantOutput;
  usage: { in: number; out: number; cached: number };
  costUsdMicros: number;
  /** The pending decision approval this turn raised, if any. */
  aid?: string;
}

export interface TurnResult {
  status: "ok" | "duplicate" | "not_found" | "closed" | "no_clients";
  turns: SpokenTurn[];
  card: MesaCard | null;
  /** The companion ran out of energy: free_min with this line and chip. */
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
      : p.kind === "session"
        ? { kind: "session", sid: p.sid }
        : { kind: "brain", pid: p.pid, provider: p.provider, modelRef: p.modelRef };

const tokensOf = (u: BrainUsage) => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
const ZERO: BrainUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

/** Provider cost from prices.yaml; throws for an unpriced model (callers fail closed). */
export const costMicros = (prices: PricesConfig, provider: BrainProviderId, model: string, u: BrainUsage) =>
  llmCostMicros(prices, provider, model, {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite5m,
    cacheWriteTtl: "5m",
  }) +
  (u.cacheWrite1h > 0
    ? llmCostMicros(prices, provider, model, { input: 0, output: 0, cacheWrite: u.cacheWrite1h, cacheWriteTtl: "1h" })
    : 0);

export const DECISION_TTL_MS = 10 * 60 * 1000;

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
  const seal = (value: unknown, aad = `mesa:${req.mid}`) => sealJson(value, recipients, aad);

  const trusted = req.source === "owner";
  const addressed = await moderate({ text: req.text, trusted, participants: mesa.participants, cheap: d.cheap });
  const human = mesa.participants.find((p) => p.kind === "human");
  const ownerName = human?.name ?? (req.locale === "es" ? "Tú" : "You");
  // Only cards of sessions this Mesa references, under the Mesa's own names for them.
  const sessions = mesa.participants.flatMap((p) => {
    if (p.kind !== "session") return [];
    const c = req.sessionCards?.find((x) => x.sid === p.sid);
    return c ? [{ name: p.name, sid: p.sid, card: c.card }] : [];
  });

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
  // BYO isn't limited by the managed plan: it uses the person's profile, or standard on free_min.
  const byoProfile = profile === "free_min" ? "standard" : profile;
  const inputSource: Source = trusted ? "owner" : req.source;
  const recent: RecentTurn[] = [...req.recent];
  const input: RecentTurn = {
    speaker: trusted ? ownerName : `${ownerName} (reenvía)`,
    source: inputSource,
    text: req.text,
  };
  let doc: MesaDoc = mesa;
  let managedClosed: string | null = null;

  for (const speaker of addressed) {
    // ---- who pays, which provider and model
    const target = providerFor(d.models, byoProfile, speaker);
    const byoBrain = target && d.brains.byo ? await d.brains.byo(req.owner, target) : null;
    let mode: "byo" | "managed";
    let brain: Brain;
    let provider: BrainProviderId;
    let model: string;
    if (byoBrain) {
      const r = resolveModel(d.models, byoProfile, speaker, (p) => p === byoBrain.provider);
      if ("unavailable" in r) {
        result.skipped.push({ pid: speaker.pid, reason: r.unavailable });
        continue;
      }
      ({ provider, model } = r);
      brain = byoBrain;
      mode = "byo";
    } else {
      if (managedClosed) {
        result.skipped.push({ pid: speaker.pid, reason: managedClosed });
        continue;
      }
      const r = resolveModel(d.models, profile, speaker, (p) => !!d.brains.managed[p]);
      if ("unavailable" in r && r.unavailable !== "free_min") {
        result.skipped.push({ pid: speaker.pid, reason: r.unavailable });
        continue;
      }
      if ("unavailable" in r) {
        // free_min: no managed spend; the gate below produces the in-character line.
        provider = "anthropic";
        model = "";
      } else {
        ({ provider, model } = r);
        // Price check first: an unpriced model fails closed before anything is admitted or spent.
        try {
          costMicros(d.prices, provider, model, ZERO);
        } catch {
          result.skipped.push({ pid: speaker.pid, reason: "unpriced_model" });
          continue;
        }
      }
      brain = d.brains.managed[provider]!;
      mode = "managed";
    }

    const brief = buildBrief({
      speaker,
      locale: req.locale,
      goal: req.goal,
      card: req.card,
      recent,
      input,
      sessions,
      profile: (mode === "byo" ? byoProfile : profile === "free_min" ? "low" : profile) as BriefProfile,
      table: mesa.participants.map((p) => p.name),
    });
    const maxTokens = d.maxOutputTokens ?? 800;
    const estimate = brief.tokens + maxTokens;

    // ---- budget caps (managed AND BYO: the runaway-loop guard)
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

    // ---- managed: admit before any spend
    let reservationId: string | null = null;
    if (mode === "managed") {
      const gate = await admitManaged({
        hub: d.hub,
        entitlements,
        request: {
          external_user_id: req.owner,
          external_job_id: `mesa:${req.mid}:${req.tid}:${speaker.pid}`,
          class: "job",
          operation: speaker.kind === "companion" ? "companion.turn" : "mesa.turn",
          // From the cost, not raw LLM tokens, like every other caller (review R-M5); the basis says
          // whether the hub adds the margin (HUB_RESERVE_BASIS).
          est_tokens: model
            ? reserveTokens(
                costMicros(d.prices, provider, model, { ...ZERO, input: brief.tokens, output: maxTokens }),
                d.reserveBasis,
              )
            : 0,
        },
        locale: req.locale,
      });
      if (!gate.ok) {
        if ("outOfEnergy" in gate) {
          await outOfEnergyTurn(d, req, mesa, speaker, gate.outOfEnergy, seal, newId, result);
          managedClosed = "out_of_energy";
        } else {
          managedClosed = `refused:${gate.refused}`;
          result.skipped.push({ pid: speaker.pid, reason: managedClosed });
        }
        result.stopped ??= managedClosed;
        continue;
      }
      reservationId = gate.reservationId;
      if (!model || !brain) {
        await d.hub.settle({ reservation_id: reservationId, outcome: "cancelled" }).catch(() => undefined);
        result.skipped.push({ pid: speaker.pid, reason: "unavailable" });
        continue;
      }
    }

    // ---- the call
    let call;
    try {
      call = await brain.call({ model, persona: brief.persona, context: brief.context, maxTokens });
    } catch (err) {
      if (reservationId)
        await d.hub.settle({ reservation_id: reservationId, outcome: "failed" }).catch(() => undefined);
      d.log?.("mesa.brain_failed", {
        mid: req.mid,
        pid: speaker.pid,
        provider,
        billing: mode,
        error: errorMessage(err),
      });
      result.skipped.push({ pid: speaker.pid, reason: "brain_error" });
      continue;
    }

    const u = call.usage;
    let cost: number;
    try {
      cost = costMicros(d.prices, provider, model, u);
    } catch (err) {
      if (mode === "managed") throw err; // checked above; unreachable
      cost = 0; // BYO: an estimate only, never billed
    }
    const tokens = tokensOf(u);
    const tid = newId();
    const usage = { in: u.input + u.cacheWrite5m + u.cacheWrite1h, out: u.output, cached: u.cacheRead };
    const event = usageEvent(
      {
        owner: req.owner,
        billingMode: mode === "byo" ? "byo_api_key" : "managed",
        origin: speaker.kind === "companion" ? "companion.turn" : "mesa.turn",
      },
      {
        kind: "llm.tokens",
        provider,
        amount: tokens,
        costUsdMicros: cost,
        occurredAt: d.now(),
        sourceId: `mesa.turn:${req.mid}:${tid}`,
        ...(reservationId ? { reservationId } : {}),
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

    // ---- a decision request: a pending approval the person signs (never decided here)
    let aid: string | undefined;
    const ask = call.output.decision_needed;
    const turnDoc = {
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
      provider,
      model,
      profile: mode === "byo" ? byoProfile : profile,
      billingMode: mode,
      ...(mode === "byo" ? { estCostUsdMicros: cost } : {}),
      decisionNeeded: !!ask && trusted,
    };
    try {
      await d.store.appendTurn(req.owner, req.mid, tid, turnDoc, { pid: speaker.pid, tokens, events: [event] });
    } catch (err) {
      // The provider was already paid: the usage still has to be reported (review R-L9). Record
      // it on its own (same idempotent source_id), then release the reservation as completed.
      const recorded = await d.store
        .enqueueUsage(req.owner, [event])
        .then(() => true)
        .catch(() => false);
      if (reservationId)
        await d.hub
          .settle({ reservation_id: reservationId, outcome: recorded ? "succeeded" : "failed" })
          .catch(() => undefined);
      d.log?.("mesa.turn_write_failed", { mid: req.mid, pid: speaker.pid, usageRecorded: recorded });
      throw err;
    }
    if (reservationId)
      await d.hub.settle({ reservation_id: reservationId, outcome: "succeeded" }).catch(() => undefined);
    // Only the person's own words may lead to a decision request: text forwarded from an MCP app
    // or a room never raises an approval, whatever the model says (review R-L11).
    if (ask && trusted) {
      aid = `apr_${randomUUID().replace(/-/g, "")}`;
      await d.store.createDecisionApproval(req.owner, {
        aid,
        mid: req.mid,
        tid,
        origin: `client:${req.deviceId}`,
        detailsCt: await seal(
          {
            kind: "mesa.decision",
            mid: req.mid,
            tid,
            from: speaker.name,
            question: ask.question,
            options: ask.options,
          },
          `approval:${aid}`,
        ),
      });
    }
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
      provider,
      model,
      billing: mode,
      output: call.output,
      usage,
      costUsdMicros: cost,
      ...(aid ? { aid } : {}),
    });
    // Later speakers in this round hear it, as quoted data.
    recent.push({ speaker: speaker.name, source: `participant:${speaker.pid}`, text: call.output.say });
  }

  result.card = mergeCard(
    req.card,
    req.mid,
    req.goal,
    result.turns.filter((t) => t.billing !== "free_min").map((t) => ({ pid: t.pid, name: t.name, output: t.output })),
  );
  return result;
};

/** Finish on free_min: the companion says it's tired, in character (no LLM call, no cost). */
const outOfEnergyTurn = async (
  d: TurnDeps,
  req: TurnRequest,
  mesa: MesaDoc,
  speaker: Speaker,
  oe: OutOfEnergy,
  seal: (v: unknown) => ReturnType<typeof sealJson>,
  newId: () => string,
  result: TurnResult,
) => {
  const companion = mesa.participants.find((p): p is Speaker => p.kind === "companion") ?? speaker;
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
    billingMode: "free_min",
    energy: { kind: oe.kind, animation: oe.animation, chip: oe.chip, presentation: oe.presentation },
  });
  result.energy = oe;
  result.turns.push({
    tid,
    pid: companion.pid,
    name: companion.name,
    provider: "none",
    model: "free_min",
    billing: "free_min",
    output,
    usage: { in: 0, out: 0, cached: 0 },
    costUsdMicros: 0,
  });
};
