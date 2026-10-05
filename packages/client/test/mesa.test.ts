import { describe, expect, it } from "vitest";
import { fromB64url, sealJson } from "@chalito/crypto";
import {
  MCP_INBOX,
  clientBoxKeys,
  httpMesa,
  listMesas,
  readInbox,
  readTurns,
  recentForBrief,
  sealBrainKey,
  sealedMesaState,
  type MesaDb,
  type MesaParticipant,
} from "../src/mesa.js";
import { newDevice, testKeys } from "./helpers.js";

type Row = Record<string, unknown>;

/** Equality filters + ascending order, like the FakeDb and RLS reads the screens use. */
const fakeDb = (tables: Record<string, Row[]>): MesaDb => ({
  from: (table) => {
    const eq: [string, unknown][] = [];
    let single = false;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (eq.push([c, v]), q),
      order: () => q,
      maybeSingle: () => ((single = true), q),
      then: (ok: (v: { data: unknown; error: null }) => unknown) => {
        const rows = (tables[table] ?? []).filter((r) => eq.every(([k, v]) => r[k] === v));
        return Promise.resolve(ok({ data: single ? (rows[0] ?? null) : rows, error: null }));
      },
    };
    return q as never;
  },
});

const COMPANION = "chl_" + "a".repeat(26);
const PARTS: MesaParticipant[] = [
  { kind: "human", pid: "owner", name: "Tú", uid: "u1" },
  { kind: "companion", pid: "companion", name: "Chalito", companionId: COMPANION },
  { kind: "brain", pid: "claude", name: "Claude", provider: "anthropic" },
];

describe("mesa reads", () => {
  it("lists Mesas newest first and never the MCP inbox", async () => {
    const db = fakeDb({
      mesas: [
        { mid: "m_a", cursor: 1, doc: { kind: "mesa", participants: PARTS, status: "open", createdAt: 1 } },
        { mid: MCP_INBOX, cursor: 2, doc: { kind: "mcp_inbox" } },
        { mid: "m_b", cursor: 3, doc: { kind: "mesa", participants: PARTS, status: "budget_reached", createdAt: 2 } },
      ],
    });
    const list = await listMesas(db);
    expect(list.map((m) => m.mid)).toEqual(["m_b", "m_a"]);
    expect(list[0]!.status).toBe("budget_reached");
    expect(list[0]!.participants.map((p) => p.pid)).toEqual(["owner", "companion", "claude"]);
  });

  it("opens turns sealed to this device, resolves speakers, keeps only the app's recharge link", async () => {
    const me = await newDevice();
    const other = await newDevice();
    const to = async (d: typeof me) => ({ [d.deviceId]: await fromB64url(d.pubBox) });
    const aad = "mesa:m_a";
    const db = fakeDb({
      mesa_turns: [
        {
          mid: "m_a",
          tid: "t1",
          cursor: 1,
          doc: {
            speaker: { kind: "human", uid: "u1" },
            outCt: await sealJson({ say: "Hola <b>mesa</b>", source: "owner" }, await to(me), aad),
            emotion: { tag: "neutral", intensity: 0 },
            t: 10,
          },
        },
        {
          mid: "m_a",
          tid: "t2",
          cursor: 2,
          doc: {
            speaker: { kind: "brain", pid: "claude", provider: "anthropic", modelRef: "auto" },
            outCt: await sealJson(
              {
                say: "¿Cuál prefieres?",
                proposals: ["A"],
                objections: [],
                decision_needed: { question: "¿A o B?", options: ["A", "B"] },
                emotion: { tag: "curious", intensity: 0.4 },
              },
              await to(me),
              aad,
            ),
            emotion: { tag: "curious", intensity: 0.4 },
            billingMode: "byo",
            t: 11,
          },
        },
        {
          mid: "m_a",
          tid: "t3",
          cursor: 3,
          doc: {
            speaker: { kind: "companion", companionId: COMPANION },
            outCt: await sealJson({ say: "Estoy cansado" }, await to(me), aad),
            emotion: { tag: "tired", intensity: 0.8 },
            billingMode: "free_min",
            energy: { kind: "out_of_energy", chip: { label: "Recargar", href: "https://evil.example" } },
            t: 12,
          },
        },
        {
          mid: "m_a",
          tid: "t4",
          cursor: 4,
          doc: {
            speaker: { kind: "brain", pid: "claude" },
            outCt: await sealJson({ say: "no para ti" }, await to(other), aad),
            emotion: { tag: "neutral", intensity: 0 },
            t: 13,
          },
        },
      ],
    });
    const turns = await readTurns(db, testKeys(me), { mid: "m_a", participants: PARTS });
    expect(turns.map((t) => t.speaker?.name ?? null)).toEqual(["Tú", "Claude", "Chalito", "Claude"]);
    expect(turns[0]).toMatchObject({ text: "Hola <b>mesa</b>", source: "owner" });
    expect(turns[1]).toMatchObject({ decision: { question: "¿A o B?", options: ["A", "B"] }, billing: "byo" });
    expect(turns[2]!.energy).toEqual({ chip: { label: "Recargar", href: "/creditos" } });
    expect(turns[3]!.text).toBeNull();

    expect(recentForBrief(turns, "Tú")).toEqual([
      { speaker: "Tú", source: "owner", text: "Hola <b>mesa</b>" },
      { speaker: "Claude", source: "participant:claude", text: "¿Cuál prefieres?" },
      { speaker: "Chalito", source: "participant:companion", text: "Estoy cansado" },
    ]);
  });

  it("the inbox: only the gateway's origins, newest first", async () => {
    const me = await newDevice();
    const to = { [me.deviceId]: await fromB64url(me.pubBox) };
    const aad = `mesa:${MCP_INBOX}`;
    const db = fakeDb({
      mesa_turns: [
        {
          mid: MCP_INBOX,
          tid: "i1",
          doc: { origin: "mcp:claude", t: 1, ct: await sealJson({ text: "uno" }, to, aad) },
        },
        { mid: MCP_INBOX, tid: "i2", doc: { origin: "evil", t: 2, ct: await sealJson({ text: "dos" }, to, aad) } },
        {
          mid: MCP_INBOX,
          tid: "i3",
          doc: { origin: "mcp:chatgpt", t: 3, ct: await sealJson({ text: "tres" }, to, aad) },
        },
      ],
    });
    expect((await readInbox(db, testKeys(me))).map((i) => [i.origin, i.text])).toEqual([
      ["mcp:chatgpt", "tres"],
      ["mcp:claude", "uno"],
    ]);
  });

  it("BYO keys are sealed to active clients only, bound to owner and provider", async () => {
    const me = await newDevice();
    const db = fakeDb({
      devices: [
        { owner: "o", device_id: me.deviceId, role: "client", revoked: false, pub_box: me.pubBox },
        { owner: "o", device_id: "gone", role: "client", revoked: true, pub_box: me.pubBox },
        { owner: "o", device_id: "pc", role: "agent", revoked: false, pub_box: me.pubBox },
      ],
    });
    const recipients = await clientBoxKeys(db, "o");
    expect(Object.keys(recipients)).toEqual([me.deviceId]);
    const keys = testKeys(me);
    const env = await sealBrainKey(keys, recipients, "o", "openai", "sk-test-1234");
    expect(JSON.stringify(env)).not.toContain("sk-test");
    expect(await keys.open(env, "brainkey:o:openai")).toMatchObject({ key: "sk-test-1234" });
    await expect(keys.open(env, "brainkey:o:xai")).rejects.toThrow();
  });

  it("goal and card are kept sealed to this device", async () => {
    const me = await newDevice();
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const s = sealedMesaState(testKeys(me), storage);
    await s.set("m_a", { goal: "Elegir nombre", card: null });
    expect([...mem.values()].join()).not.toContain("Elegir");
    expect(await s.get("m_a")).toEqual({ goal: "Elegir nombre", card: null });
    const stranger = sealedMesaState(testKeys(await newDevice()), storage);
    expect(await stranger.get("m_a")).toBeNull();
  });
});

describe("httpMesa", () => {
  const fetchOf = (status: number, body: unknown, seen: { url?: string; init?: RequestInit }) =>
    (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  it("create: the plan's brain limit comes back", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const api = httpMesa(
      "https://o.example",
      async () => "tok",
      fetchOf(403, { error: "mesa_brains_limit", limit: 1 }, seen),
    );
    expect(await api.create([{ kind: "brain", pid: "claude", name: "Claude", provider: "anthropic" }])).toEqual({
      ok: false,
      error: "mesa_brains_limit",
      limit: 1,
    });
    expect(seen.url).toBe("https://o.example/v1/mesas");
    expect((seen.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("turn: decisions by tid, energy with only the app's link", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const api = httpMesa(
      "https://o.example",
      async () => "tok",
      fetchOf(
        200,
        {
          status: "ok",
          card: null,
          turns: [{ tid: "t9", aid: "apr_1" }, { tid: "t8" }],
          energy: { kind: "out_of_energy", line: "Me cansé", chip: { label: "Recargar", href: "javascript:x" } },
        },
        seen,
      ),
    );
    const r = await api.turn("m_a", {
      tid: "t1",
      text: "hola",
      source: "owner",
      goal: "",
      card: null,
      recent: [],
      sessionCards: [],
      locale: "es",
    });
    expect(r).toEqual({
      ok: true,
      card: null,
      decisions: { t9: "apr_1" },
      energy: { line: "Me cansé", chip: { label: "Recargar", href: "/creditos" } },
      stopped: null,
    });
    expect(seen.url).toBe("https://o.example/v1/mesas/m_a/turns");
  });

  it("no bearer or no base: nothing is sent", async () => {
    const seen: { url?: string } = {};
    expect(await httpMesa("", async () => "t", fetchOf(204, null, seen)).deleteBrainKey("xai")).toBe("error");
    expect(await httpMesa("https://o", async () => null, fetchOf(204, null, seen)).deleteBrainKey("xai")).toBe("error");
    expect(seen.url).toBeUndefined();
  });
});
