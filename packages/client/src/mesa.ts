import type { MesaCard, SealedEnvelope, SessionCard } from "@chalito/protocol";
import type { ClientKeys } from "./keys.js";

/**
 * Mesa (M9) for client shells: the orchestrator's HTTP surface (create, turns, BYO keys) and the
 * RLS reads of chalito.mesas / mesa_turns / brain_keys, with turns opened on this device (AAD
 * `mesa:<mid>`). Everything opened here is data to show as TEXT: never markup, never instructions.
 * The goal and the Mesa Card live with the clients, not the server (apps/orchestrator core/mesa.ts),
 * so this device keeps them sealed to itself (`mesastate:<mid>`).
 */

export const BRAIN_PROVIDERS = ["anthropic", "openai", "xai", "google"] as const;
export type BrainProviderId = (typeof BRAIN_PROVIDERS)[number];
/** The MCP inbox (post_to_mesa) is a pseudo-Mesa with this id; it is never listed as a Mesa. */
export const MCP_INBOX = "mcp_inbox";

export type MesaParticipant =
  | { kind: "human"; pid: string; name: string; uid: string }
  | { kind: "companion"; pid: string; name: string; companionId: string }
  | { kind: "brain"; pid: string; name: string; provider: BrainProviderId; modelRef?: "auto" }
  | { kind: "session"; pid: string; name: string; sid: string };

export type MesaStatus = "open" | "budget_reached" | "closed";

export interface MesaSummary {
  mid: string;
  participants: MesaParticipant[];
  status: MesaStatus;
  createdAt: number;
  cursor: number;
}

export type MesaSource = "owner" | "mcp:claude" | "mcp:chatgpt" | "room";
export type Emotion = { tag: string; intensity: number };

export interface MesaTurnView {
  tid: string;
  t: number;
  cursor: number;
  /** The participant who spoke (resolved against the Mesa's list; null if it isn't there). */
  speaker: MesaParticipant | null;
  /** The opened text, or null when this device can't open it (sealed before it was added). */
  text: string | null;
  /** Input turns: who wrote it (the person, or text forwarded from an app or a room). */
  source: MesaSource | null;
  emotion: Emotion;
  proposals: string[];
  objections: string[];
  decision: { question: string; options: string[] } | null;
  /** The companion ran out of energy (free_min): its recharge chip. */
  energy: { chip: { label: string; href: string } } | null;
  billing: "managed" | "byo" | "free_min" | null;
}

export interface InboxItem {
  tid: string;
  t: number;
  /** "mcp:claude" | "mcp:chatgpt" (the gateway's grant, not the text's claim). */
  origin: string;
  text: string;
}

export interface BrainKeyRow {
  provider: BrainProviderId;
  /** Last 4 characters, or "". */
  hint: string;
  cloud: boolean;
}

// ---- reads (RLS: the owner's own rows, as this device) --------------------------------------

type Row = Record<string, unknown>;
interface Query extends PromiseLike<{ data: Row[] | Row | null; error: unknown }> {
  select(c: string): Query;
  eq(c: string, v: unknown): Query;
  order(c: string, o?: { ascending: boolean }): Query;
  maybeSingle(): Query;
}
/** The slice of a Supabase client the reads use (schema chalito). */
export interface MesaDb {
  from(table: string): Query;
}

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");
const strs = (v: unknown, n: number, max: number) =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .slice(0, n)
        .map((x) => x.slice(0, max))
    : [];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const isProvider = (v: unknown): v is BrainProviderId => (BRAIN_PROVIDERS as readonly unknown[]).includes(v);

const participantOf = (p: unknown): MesaParticipant | null => {
  const r = p as Row | null;
  if (!r || typeof r.pid !== "string" || typeof r.name !== "string") return null;
  const base = { pid: r.pid, name: r.name.slice(0, 40) };
  switch (r.kind) {
    case "human":
      return { kind: "human", ...base, uid: str(r.uid, 128) };
    case "companion":
      return typeof r.companionId === "string" ? { kind: "companion", ...base, companionId: r.companionId } : null;
    case "brain":
      return isProvider(r.provider) ? { kind: "brain", ...base, provider: r.provider } : null;
    case "session":
      return typeof r.sid === "string" ? { kind: "session", ...base, sid: r.sid } : null;
    default:
      return null;
  }
};

const summaryOf = (r: Row): MesaSummary | null => {
  const doc = r.doc as Row | null;
  if (typeof r.mid !== "string" || doc?.kind !== "mesa" || !Array.isArray(doc.participants)) return null;
  const status = doc.status === "budget_reached" || doc.status === "closed" ? doc.status : "open";
  return {
    mid: r.mid,
    participants: doc.participants.map(participantOf).filter((p): p is MesaParticipant => p !== null),
    status,
    createdAt: num(doc.createdAt),
    cursor: num(r.cursor),
  };
};

/** The person's Mesas, newest first (the MCP inbox isn't one). */
export const listMesas = async (db: MesaDb): Promise<MesaSummary[]> => {
  const { data, error } = await db.from("mesas").select("mid, doc, cursor").order("cursor");
  if (error || !Array.isArray(data)) throw new Error("mesas");
  return data
    .map(summaryOf)
    .filter((m): m is MesaSummary => m !== null)
    .sort((a, b) => b.cursor - a.cursor);
};

export const readMesa = async (db: MesaDb, mid: string): Promise<MesaSummary | null> => {
  const { data, error } = await db.from("mesas").select("mid, doc, cursor").eq("mid", mid).maybeSingle();
  if (error) throw new Error("mesa");
  return data && !Array.isArray(data) ? summaryOf(data) : null;
};

/** Who a stored speaker ref is, among the Mesa's participants. */
const speakerOf = (ref: unknown, participants: readonly MesaParticipant[]): MesaParticipant | null => {
  const s = ref as Row | null;
  switch (s?.kind) {
    case "human":
      return participants.find((p) => p.kind === "human") ?? null;
    case "companion":
      return participants.find((p) => p.kind === "companion" && p.companionId === s.companionId) ?? null;
    case "brain":
      return participants.find((p) => p.kind === "brain" && p.pid === s.pid) ?? null;
    default:
      return null;
  }
};

const SOURCES: readonly MesaSource[] = ["owner", "mcp:claude", "mcp:chatgpt", "room"];

/** A Mesa's turns in order, each opened on this device (or shown as sealed). */
export const readTurns = async (
  db: MesaDb,
  keys: Pick<ClientKeys, "open">,
  mesa: Pick<MesaSummary, "mid" | "participants">,
): Promise<MesaTurnView[]> => {
  const { data, error } = await db.from("mesa_turns").select("tid, doc, cursor").eq("mid", mesa.mid).order("cursor");
  if (error || !Array.isArray(data)) throw new Error("turns");
  const out: MesaTurnView[] = [];
  for (const r of data) {
    const doc = (r.doc as Row | null) ?? {};
    // Not sealed to this device (added later) or tampered: shown as sealed.
    const opened = await keys.open<Row>(doc.outCt as SealedEnvelope, `mesa:${mesa.mid}`).catch(() => null);
    const emotion = doc.emotion as Row | undefined;
    const ask = opened?.decision_needed as Row | undefined;
    const energy = doc.energy as Row | undefined;
    const chip = energy?.chip as Row | undefined;
    const source = opened?.source ?? doc.source;
    out.push({
      tid: str(r.tid, 128),
      t: num(doc.t),
      cursor: num(r.cursor),
      speaker: speakerOf(doc.speaker, mesa.participants),
      text: opened && typeof opened.say === "string" ? opened.say.slice(0, 4000) : null,
      source: (SOURCES as readonly unknown[]).includes(source) ? (source as MesaSource) : null,
      emotion: {
        tag: str(emotion?.tag, 32) || "neutral",
        intensity: Math.min(1, Math.max(0, num(emotion?.intensity))),
      },
      proposals: strs(opened?.proposals, 5, 300),
      objections: strs(opened?.objections, 5, 300),
      decision:
        ask && typeof ask.question === "string"
          ? { question: ask.question.slice(0, 300), options: strs(ask.options, 6, 120) }
          : null,
      // Only the app's own recharge page: never a link the row could point elsewhere.
      energy:
        energy?.kind === "out_of_energy"
          ? {
              chip: { label: str(chip?.label, 60), href: chip?.href === "/en/creditos" ? "/en/creditos" : "/creditos" },
            }
          : null,
      billing:
        doc.billingMode === "managed" || doc.billingMode === "byo" || doc.billingMode === "free_min"
          ? doc.billingMode
          : null,
    });
  }
  return out;
};

/** Text connected apps posted (post_to_mesa), opened here: quoted data the person may bring to a Mesa. */
export const readInbox = async (db: MesaDb, keys: Pick<ClientKeys, "open">): Promise<InboxItem[]> => {
  const { data, error } = await db.from("mesa_turns").select("tid, doc, cursor").eq("mid", MCP_INBOX).order("cursor");
  if (error || !Array.isArray(data)) throw new Error("inbox");
  const out: InboxItem[] = [];
  for (const r of data) {
    const doc = (r.doc as Row | null) ?? {};
    // The gateway's grant says which app it was; the sealed body can't claim another.
    if (doc.origin !== "mcp:claude" && doc.origin !== "mcp:chatgpt") continue;
    try {
      const o = await keys.open<Row>(doc.ct as SealedEnvelope, `mesa:${MCP_INBOX}`);
      if (typeof o?.text === "string" && o.text)
        out.push({ tid: str(r.tid, 128), t: num(doc.t), origin: doc.origin, text: o.text.slice(0, 4000) });
    } catch {
      /* sealed before this device was added */
    }
  }
  return out.reverse();
};

export const readBrainKeys = async (db: MesaDb): Promise<BrainKeyRow[]> => {
  const { data, error } = await db.from("brain_keys").select("provider, hint, cloud");
  if (error || !Array.isArray(data)) throw new Error("brain_keys");
  return data
    .filter((r) => isProvider(r.provider))
    .map((r) => ({ provider: r.provider as BrainProviderId, hint: str(r.hint, 4), cloud: r.cloud === true }));
};

/** The owner's active client devices (deviceId → pubBox): who a BYO key is sealed to. */
export const clientBoxKeys = async (db: MesaDb, owner: string): Promise<Record<string, string>> => {
  const { data, error } = await db.from("devices").select("device_id, role, revoked, pub_box").eq("owner", owner);
  if (error || !Array.isArray(data)) throw new Error("devices");
  const out: Record<string, string> = {};
  for (const r of data)
    if (r.role === "client" && r.revoked === false && typeof r.pub_box === "string" && typeof r.device_id === "string")
      out[r.device_id] = r.pub_box;
  return out;
};

// ---- the brief a turn needs (the client holds the history) ---------------------------------

export interface RecentTurn {
  speaker: string;
  source: string;
  text: string;
}

/** The last ≤3 opened turns, as the orchestrator's brief takes them (quoted as data there). */
export const recentForBrief = (turns: readonly MesaTurnView[], ownerName: string): RecentTurn[] =>
  turns
    .filter((t) => t.text !== null && t.speaker !== null)
    .slice(-3)
    .map((t) => ({
      speaker: t.speaker!.kind === "human" ? ownerName : t.speaker!.name,
      source: t.speaker!.kind === "human" ? (t.source ?? "owner") : `participant:${t.speaker!.pid}`,
      text: t.text!.slice(0, 4000),
    }));

// ---- this device's goal + card for a Mesa (sealed to itself) --------------------------------

export interface MesaLocalState {
  goal: string;
  card: MesaCard | null;
}

export interface MesaStateStore {
  get(mid: string): Promise<MesaLocalState | null>;
  set(mid: string, s: MesaLocalState): Promise<void>;
}

/** Kept in a key-value storage (localStorage on the web) as ciphertext only this device opens. */
export const sealedMesaState = (
  keys: Pick<ClientKeys, "deviceId" | "pubBox" | "seal" | "open">,
  storage: Pick<Storage, "getItem" | "setItem">,
): MesaStateStore => {
  const k = (mid: string) => `chalito.mesa.${mid}`;
  const aad = (mid: string) => `mesastate:${mid}`;
  return {
    get: async (mid) => {
      try {
        const raw = storage.getItem(k(mid));
        if (!raw) return null;
        const s = await keys.open<MesaLocalState>(JSON.parse(raw) as SealedEnvelope, aad(mid));
        return { goal: str(s?.goal, 400), card: (s?.card as MesaCard | null) ?? null };
      } catch {
        return null;
      }
    },
    set: async (mid, s) => {
      try {
        const env = await keys.seal({ goal: s.goal, card: s.card }, { [keys.deviceId]: keys.pubBox }, aad(mid));
        storage.setItem(k(mid), JSON.stringify(env));
      } catch {
        /* storage unavailable: the goal is asked for again */
      }
    },
  };
};

// ---- the orchestrator (bearer = this device) -------------------------------------------------

export type CreateParticipant =
  | { kind: "companion"; pid: string; name: string; companionId: string }
  | { kind: "brain"; pid: string; name: string; provider: BrainProviderId }
  | { kind: "session"; pid: string; name: string; sid: string };

export type CreateResult = { ok: true; mid: string } | { ok: false; error: string; limit?: number | null };

export interface TurnInput {
  tid: string;
  text: string;
  source: MesaSource;
  goal: string;
  card: MesaCard | null;
  recent: RecentTurn[];
  sessionCards: { sid: string; card: SessionCard }[];
  locale: "es" | "en";
}

export interface TurnOk {
  ok: true;
  card: MesaCard | null;
  /** The decision approvals this round raised (tid of the turn → aid). */
  decisions: Record<string, string>;
  energy: { line: string; chip: { label: string; href: string } } | null;
  stopped: string | null;
}
export type TurnResult = TurnOk | { ok: false; error: string; stopped?: string };

export interface BrainKeyPut {
  sealedCt: SealedEnvelope;
  cloud: boolean;
  key?: string;
  hint?: string;
}

export interface MesaApi {
  create(participants: CreateParticipant[], ownerName?: string): Promise<CreateResult>;
  turn(mid: string, input: TurnInput): Promise<TurnResult>;
  putBrainKey(provider: BrainProviderId, body: BrainKeyPut): Promise<"ok" | "error">;
  deleteBrainKey(provider: BrainProviderId): Promise<"ok" | "not_found" | "error">;
  /** After inserting a signed Decision: asks the orchestrator to verify it (the poke carries no authority). */
  checkDecision(aid: string): Promise<"approved" | "denied" | "pending" | "error">;
}

export const httpMesa = (
  base: string,
  token: () => Promise<string | null>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): MesaApi => {
  const call = async (method: string, path: string, body?: unknown) => {
    const bearer = await token();
    if (!base || !bearer) return null;
    try {
      return await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
      });
    } catch {
      return null;
    }
  };
  const json = async (r: Response) => ((await r.json().catch(() => null)) as Row | null) ?? {};
  return {
    create: async (participants, ownerName) => {
      const r = await call("POST", "/v1/mesas", { participants, ...(ownerName ? { ownerName } : {}) });
      if (!r) return { ok: false, error: "network" };
      const b = await json(r);
      if (r.status === 201 && typeof b.mid === "string") return { ok: true, mid: b.mid };
      return {
        ok: false,
        error: typeof b.error === "string" ? b.error : "error",
        ...("limit" in b ? { limit: typeof b.limit === "number" ? b.limit : null } : {}),
      };
    },
    turn: async (mid, input) => {
      const r = await call("POST", `/v1/mesas/${encodeURIComponent(mid)}/turns`, input);
      if (!r) return { ok: false, error: "network" };
      const b = await json(r);
      if (!r.ok)
        return {
          ok: false,
          error: typeof b.error === "string" ? b.error : "error",
          ...(typeof b.stopped === "string" ? { stopped: b.stopped } : {}),
        };
      const decisions: Record<string, string> = {};
      for (const t of Array.isArray(b.turns) ? (b.turns as Row[]) : [])
        if (typeof t.tid === "string" && typeof t.aid === "string") decisions[t.tid] = t.aid;
      const e = b.energy as Row | undefined;
      return {
        ok: true,
        card: (b.card as MesaCard | null) ?? null,
        decisions,
        energy:
          e?.kind === "out_of_energy"
            ? {
                line: str(e.line, 300),
                chip: {
                  label: str((e.chip as Row | undefined)?.label, 60),
                  href: (e.chip as Row | undefined)?.href === "/en/creditos" ? "/en/creditos" : "/creditos",
                },
              }
            : null,
        stopped: typeof b.stopped === "string" ? b.stopped : null,
      };
    },
    putBrainKey: async (provider, body) => {
      const r = await call("PUT", `/v1/brain-keys/${provider}`, body);
      return r?.status === 204 ? "ok" : "error";
    },
    deleteBrainKey: async (provider) => {
      const r = await call("DELETE", `/v1/brain-keys/${provider}`);
      return r?.status === 204 ? "ok" : r?.status === 404 ? "not_found" : "error";
    },
    checkDecision: async (aid) => {
      const r = await call("POST", `/v1/decisions/${encodeURIComponent(aid)}/check`);
      if (!r?.ok) return "error";
      const s = (await json(r)).status;
      return s === "approved" || s === "denied" || s === "pending" ? s : "error";
    },
  };
};

/** A BYO key sealed to the person's client devices (aad `brainkey:<owner>:<provider>`). */
export const sealBrainKey = (
  keys: Pick<ClientKeys, "seal">,
  recipients: Readonly<Record<string, string>>,
  owner: string,
  provider: BrainProviderId,
  key: string,
) => keys.seal({ v: 1, provider, key }, recipients, `brainkey:${owner}:${provider}`);
