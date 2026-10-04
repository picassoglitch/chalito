/**
 * DEV/TEST ONLY: a mock Chalito backend in the browser, so the live screens and the Playwright
 * suite run without Supabase, the api or a real agent. It never ships (src/lib/env.ts
 * DEV_BACKEND, next.config.ts). What it simulates:
 *
 * - this browser as a paired client with real Ed25519/X25519 keys (what packages/client-keys
 *   will provide) and a stub step-up (in-app confirm, then "platform_biometric");
 * - one agent ("Laptop de Aldo") that, like apps/agent, only acts on decisions and commands
 *   whose signature verifies against this client's key, opens sealed prompts with its own key,
 *   and answers with sealed events;
 * - phone verification that accepts code 123456.
 *
 * Playwright drives it through `window.__chalitoDev`.
 */
import {
  canonicalize,
  deriveDeviceId,
  fromB64url,
  generateBoxKeyPair,
  generateSigningKeyPair,
  fingerprint,
  generateRoomKey,
  openJson,
  randomNonce,
  sealJson,
  sha256,
  signEnvelope,
  toB64url,
  utf8,
  verifyEnvelope,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import type { ClientKeys, EndorseWatch } from "@chalito/client";
import {
  ApiError,
  type TrustedAgent,
  endorseGlyph,
  generateDeviceKeys,
  signDeviceRegistration,
  type ApiClient,
} from "@chalito/client-keys";
import { generateShortCode } from "@chalito/glyph";
import { EndorsementBody } from "@chalito/protocol";
import type { DeviceRegistration, Endorsement, GlyphPayload, SealedEnvelope } from "@chalito/protocol";
import type { PhoneVerifier } from "@chalito/ui";
import type { Platform } from "@/lib/platform";
import type { ChannelSetter } from "@/lib/phone";
import type { Connector, ConsentRequest, McpApi } from "@/lib/mcp";
import { confirmStepUp } from "@/components/StepUpHost";
import { passkeyRef, savePasskeyRef } from "@/lib/keys";
import { httpStore } from "@/lib/store";
import { parseUsage, type UsageApi } from "@/lib/usage";
import { DEV_CATALOG } from "./catalog";
import { sealRoomEvent, unwrapKeyring, wrapRoomKeyFor } from "@chalito/rooms";
import { DEV_MARKER, FakeDb } from "./fake-db";

type Row = Record<string, unknown>;
interface Device {
  deviceId: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
  pubSign: string;
  pubBox: string;
}

const OWNER = "dev-owner";
const SID = "s_dev_1";
/** The simulated computer's locally allowed workspaces (apps/agent policy.workspaces labels). */
const AGENT_WORKSPACES = ["chalito", "web"];

const newDevice = async (): Promise<Device> => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return {
    deviceId: await deriveDeviceId(sign.publicKey),
    sign,
    box,
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
  };
};

const iso = (ms: number) => new Date(ms).toISOString();

export interface DevControls {
  marker: string;
  owner: string;
  me: string;
  agent: string;
  /** Another trusted client of the owner (for revoke). */
  other: string;
  sid: string;
  db: FakeDb;
  /** Rows the browser wrote (commands, decisions, acks), as written. */
  clientWrites(): { table: string; op: string; row: Row }[];
  rows(table: string): Row[];
  /** A new pending approval for the simulated session. */
  seedApproval(o: {
    aid: string;
    risk: "LOW" | "MED" | "HIGH" | "CRITICAL";
    ttlMs?: number;
    summary?: string;
    /** The tool input as the agent saw it (the summary may cut it, R-M10). */
    input?: unknown;
    toolName?: string;
    /** Sealed WITHOUT the agent's signed request (ADR 0019): the browser must show it unverified. */
    unverified?: boolean;
  }): Promise<void>;
  setDevMode(on: boolean, toggles?: string[]): void;
  askQuestion(questionId: string, question: string, options: string[]): Promise<void>;
  /** What the agent received, opened with its key (prompts, answers). */
  agentInbox: { type: string; text?: unknown }[];
  /** The browser's current Supabase session (who the app is signed in as). */
  session(): { access_token: string; role: unknown } | null;
  /** The current passkey fails its assertion (R-M11 replace). */
  losePasskey(): void;
  /** The agent stops reading commands and shows as offline. */
  sleepAgent(): void;
  /** The agent reconnects and, like apps/agent (R-H5), drops clients the directory marks revoked. */
  wakeAgent(): void;
  /** Whether the agent dropped this client from its local trust list. */
  agentDropped(deviceId: string): boolean;
  /** Revokes THIS browser device (as another trusted device would). */
  revokeMe(): void;
  /** GET /v1/usage/daily: "normal" (comms under target), "over" (above), "empty", or "error". */
  setUsage(mode: "normal" | "over" | "empty" | "error"): void;
  /** /v1/store: the hub balance in tokens, a one-shot failure, and the companion to dress. */
  storeState: {
    balance(): number;
    setBalance(tokens: number): void;
    failNextPurchase(how: "hub_unavailable" | "network"): void;
    /** Purchases as the api recorded them (purchaseId → charged). */
    purchases(): Record<string, { cosmeticId: string; charged: number }>;
    seedCompanion(avatar: string): void;
  };
  /** Rooms (ADR 0010): a seeded room with another family's companion, and the server's side. */
  rooms: {
    /** Creates this browser's companion (if needed) and a room "Familia" it owns, with Ana's companion. */
    seed(): Promise<{ roomId: string; me: string; ana: string; eid: string }>;
    /** Ana's companion posts a notice. */
    postAsAna(text: string): Promise<string>;
    kickMe(): void;
    dissolve(): void;
    /** A one-use invite code to another room ("Proyecto"), keyed to this device on join. */
    inviteCode: string;
    reports(): Row[];
  };
  /** /v1/endorse: the other side of "Añadir un dispositivo" / "Esperando aprobación". */
  endorse: {
    /** A new browser of the owner opens a code (for this trusted browser to approve). */
    newBrowser(name?: string): Promise<{
      codeId: string;
      shortCode: string;
      deviceId: string;
      fingerprint: string;
      glyph: GlyphPayload;
    }>;
    /** Who endorsed that code (and the computers it introduced), if anyone. */
    endorsementOf(codeId: string): { signer: string; newDeviceId: string; agents: string[] } | null;
    /** "Navegador del trabajo" approves this (new) browser's code, introducing the agent (ADR 0018). */
    approveFromOther(shortCode: string, introduce?: "agent" | "tampered" | "none"): Promise<void>;
    /** The agent refused an endorsement (its device event, R-L13). */
    refusedByAgent(clientDeviceId: string, reason: string): void;
  };
}

/** DEV/TEST: whether this browser counts as paired (localStorage "chalito.dev.paired", default yes). */
export const DEV_PAIRED_KEY = "chalito.dev.paired";
const devPaired = () => {
  try {
    return window.localStorage.getItem(DEV_PAIRED_KEY) !== "0";
  } catch {
    return true;
  }
};

export const startDevBackend = async (): Promise<Platform & { controls: DevControls }> => {
  const db = new FakeDb();
  // This browser's identity. A new browser gets a fresh one when it asks to be endorsed (/vincular).
  let me = await newDevice();
  /** Whether `me` trusts the agent's key: confirmed by its glyph, or introduced by an endorser (ADR 0018). */
  let mePairedWithAgent = true;
  let meAgentVia: "glyph" | "endorsement" = "glyph";
  const agent = await newDevice();
  const now = Date.now();
  const agentInbox: DevControls["agentInbox"] = [];
  let started = 0;

  const sealToBoth = async (value: unknown, aad: string) =>
    sealJson(
      value,
      { [me.deviceId]: await fromB64url(me.pubBox), [agent.deviceId]: await fromB64url(agent.pubBox) },
      aad,
    );
  let seq = 0;
  const event = async (type: string, extra: Row = {}, ct?: unknown) =>
    db.insert("session_events", {
      owner: OWNER,
      sid: SID,
      eid: `e${++seq}`,
      device_id: agent.deviceId,
      seq,
      t: iso(Date.now()),
      type,
      urgency: "low",
      doc: { type, ...extra, ...(ct !== undefined ? { ct: await sealToBoth(ct, `event:${SID}`) } : {}) },
    });
  let card = {
    v: 1 as const,
    sid: SID,
    cardVersion: 1,
    adapter: "claude-code" as const,
    label: "chalito",
    workspaceLabel: "chalito",
    state: "waiting_approval" as string,
    goal: "Agregar notas al README",
    lastAction: "Leyó README.md",
    pendingApprovals: 2,
    filesTouched: 0,
    blockers: [] as string[],
    openQuestion: undefined as string | undefined,
    updatedAt: now,
  };
  const session = async (patch: Partial<typeof card> = {}, doc: Row = {}) => {
    card = { ...card, ...patch, cardVersion: card.cardVersion + 1, updatedAt: Date.now() };
    const existing = db.rows("sessions").find((r) => r.sid === SID);
    const nextDoc = {
      ...((existing?.doc as Row) ?? { adapter: "claude-code", label: "chalito", permissionMode: "default" }),
      ...doc,
      state: card.state,
      card: { ct: await sealToBoth(card, `card:${SID}`) },
    };
    if (existing) db.update("sessions", (r) => r.sid === SID, { doc: nextDoc, updated_at: iso(Date.now()) });
    else
      db.insert("sessions", {
        owner: OWNER,
        sid: SID,
        device_id: agent.deviceId,
        doc: nextDoc,
        updated_at: iso(Date.now()),
      });
  };

  // ---- seed ---------------------------------------------------------------------------
  const device = (d: Device, role: "agent" | "client", name: string, kind: string, platform: string) =>
    db.insert("devices", {
      owner: OWNER,
      device_id: d.deviceId,
      role,
      kind,
      platform,
      name,
      revoked: false,
      last_seen_at: iso(now),
      dev_mode: { on: false, toggles: [], since: null },
      policy_hash: null,
      pub_sign: d.pubSign,
      pub_box: d.pubBox,
      last_event: null,
    });
  db.insert("users", {
    id: OWNER,
    tier: "pro",
    locale: "es",
    tz: "America/Mexico_City",
    call_briefing: { enabled: false },
    quiet_hours: null,
    l4_quiet_override: [],
    privacy_mode: "private",
    render_quality: "auto",
    whatsapp_opt_in: false,
    calls_enabled: false,
    sms_enabled: null,
    prefs: {},
    phone_pending_e164: null,
    phone_e164: null,
    phone_country: null,
    phone_verified_at: null,
    charges_notice_ack_at: null,
  });
  device(agent, "agent", "Laptop de Aldo", "laptop", "linux");
  // A new (unpaired) browser has no device row until it is endorsed.
  if (devPaired()) device(me, "client", "Este teléfono", "phone", "ios");
  // DEV/TEST: start with this browser already revoked ("chalito.dev.revoked" = "1").
  try {
    if (window.localStorage.getItem("chalito.dev.revoked") === "1")
      db.update("devices", (r) => r.device_id === me.deviceId, { revoked: true });
  } catch {
    /* storage unavailable */
  }
  const other = await newDevice();
  device(other, "client", "Navegador del trabajo", "web", "web");
  db.insert("connections", {
    owner: OWNER,
    device_id: agent.deviceId,
    provider: "anthropic",
    doc: { mode: "byo_api_key", connected: true },
  });
  await session();
  await event("session.started", {
    adapter: "claude-code",
    origin: `client:${me.deviceId}`,
    permissionMode: "default",
  });
  await event("message.user", { origin: `client:${me.deviceId}` }, { text: "Agrega notas al README" });
  await event("message.assistant", {}, { text: "Claro. Primero necesito tu aprobación para editar." });

  /** What a real agent seals (ADR 0019): details + its signature over {request, detailsHash}. */
  const detailsHashes = new Map<string, string>();
  const signedApproval = async (
    aid: string,
    risk: string,
    created: number,
    ttlMs: number,
    o: { summary?: string; input?: unknown; toolName?: string } = {},
  ) => {
    const details = {
      v: 1,
      toolName: o.toolName ?? (risk === "HIGH" ? "Bash" : "Write"),
      summary: o.summary ?? (risk === "HIGH" ? "Bash: rm -rf dist" : "Write: notes.txt"),
      input: o.input ?? (risk === "HIGH" ? { command: "rm -rf dist" } : { file_path: "notes.txt" }),
      reasons: risk === "HIGH" ? ["deletes files"] : [],
      origin: `client:${me.deviceId}`,
    };
    const detailsHash = [...(await sha256(utf8(canonicalize(details))))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    detailsHashes.set(aid, detailsHash);
    const request = await signEnvelope(
      "chalito.approval.v1",
      {
        v: 1,
        aid,
        requestId: `req_${aid}`,
        sid: SID,
        deviceId: agent.deviceId,
        kind: "tool",
        risk,
        stepUpRequired: risk === "HIGH" || risk === "CRITICAL",
        origin: `client:${me.deviceId}`,
        createdAt: created,
        expiresAt: created + ttlMs,
        detailsHash,
      },
      agent.deviceId,
      agent.sign.secretKey,
    );
    return { details, request };
  };

  const seedApproval: DevControls["seedApproval"] = async ({
    aid,
    risk,
    ttlMs = 10 * 60 * 1000,
    summary,
    input,
    toolName,
    unverified,
  }) => {
    const created = Date.now();
    db.insert("approvals", {
      owner: OWNER,
      aid,
      device_id: agent.deviceId,
      sid: SID,
      request_id: `req_${aid}`,
      kind: "tool",
      risk,
      origin: `client:${me.deviceId}`,
      step_up_required: risk === "HIGH" || risk === "CRITICAL",
      // ADR 0019: like apps/agent, seal the details WITH the agent's signed request over them.
      details_ct: await sealToBoth(
        unverified
          ? { details: (await signedApproval(aid, risk, created, ttlMs, { summary, input, toolName })).details }
          : await signedApproval(aid, risk, created, ttlMs, { summary, input, toolName }),
        `approval:${aid}`,
      ),
      status: "pending",
      created_at: iso(created),
      expires_at: iso(created + ttlMs),
      recommendations: [],
    });
    // The agent's own timer: no signed answer before expiry = deny.
    setTimeout(() => {
      const a = db.rows("approvals").find((r) => r.aid === aid);
      if (a?.status === "pending")
        db.update("approvals", (r) => r.aid === aid, {
          status: "expired",
          reason: "timeout_deny",
          resolved_at: iso(Date.now()),
        });
    }, ttlMs + 50);
  };
  await seedApproval({ aid: "apr_med_1", risk: "MED" });
  await seedApproval({ aid: "apr_high_1", risk: "HIGH" });
  db.insert("notifications", {
    owner: OWNER,
    nid: "n1",
    level: "L1",
    source: "approvals",
    urgency: "normal",
    counts: { approvals: 2 },
    deep_link: "/a/apr_med_1",
    state: "pending",
    created_at: iso(now),
  });

  // ---- the simulated agent ----------------------------------------------------------
  let agentAsleep = false;
  /** R-M11: the current passkey can't assert (lost or wrong authenticator). */
  let currentPasskeyLost = false;
  const agentDropped = new Set<string>();
  const trusted = new Map([[me.deviceId, await fromB64url(me.pubSign)]]);
  db.onWrite((w) => {
    if (!w.byClient) return;
    void (async () => {
      if (w.table === "approval_decisions" && w.op === "insert") {
        const env = w.row.decision as Parameters<typeof verifyEnvelope>[0];
        const check = await verifyEnvelope(env, "chalito.decision.v1", trusted);
        const body = env.body as {
          aid: string;
          requestId: string;
          allow: boolean;
          expiresAt: number;
          stepUp?: { method: string };
          detailsHash?: string;
        };
        const a = db.rows("approvals").find((r) => r.aid === body.aid);
        if (
          !check.ok ||
          !a ||
          a.status !== "pending" ||
          a.request_id !== body.requestId ||
          body.expiresAt <= Date.now() ||
          // ADR 0019: an allow must be for exactly what this agent signed.
          (body.allow && body.detailsHash !== detailsHashes.get(body.aid))
        )
          return;
        if (body.allow && a.step_up_required && !body.stepUp) return; // missing_step_up: keep waiting
        db.update("approvals", (r) => r.aid === body.aid, {
          status: body.allow ? "approved" : "denied",
          reason: body.allow ? "signed_allow" : "signed_deny",
          resolved_at: iso(Date.now()),
        });
        await event("approval.resolved", {
          aid: body.aid,
          allow: body.allow,
          reason: body.allow ? "signed_allow" : "signed_deny",
        });
        const stillPending = db.rows("approvals").filter((r) => r.status === "pending").length;
        await session({
          state: stillPending ? "waiting_approval" : "running",
          pendingApprovals: stillPending,
          lastAction: body.allow ? `Aprobado: ${String(a.aid)}` : `Denegado: ${String(a.aid)}`,
          filesTouched: card.filesTouched + (body.allow ? 1 : 0),
        });
        return;
      }
      if (w.table === "commands" && w.op === "insert") {
        if (agentAsleep) return; // a sleeping agent never sees it (commands expire)
        const env = w.row.env as Parameters<typeof verifyEnvelope>[0];
        const check = await verifyEnvelope(env, "chalito.command.v1", trusted);
        db.remove("commands", (r) => r.id === w.row.id); // the agent consumes its commands
        if (!check.ok) return;
        const body = env.body as { cid: string; payload: Row & { type: string } };
        const p = body.payload;
        const open = (ct: unknown) => openJson(ct as SealedEnvelope, agent.deviceId, agent.box, `command:${body.cid}`);
        switch (p.type) {
          case "session.start": {
            // Like apps/agent: only a locally allowed workspace; a refusal is only in its own log.
            if (!AGENT_WORKSPACES.includes(p.workspaceLabel as string)) return;
            const text = await open(p.promptCt);
            agentInbox.push({ type: p.type, text });
            const sid = `s_dev_new_${++started}`;
            const c = {
              ...card,
              sid,
              cardVersion: 1,
              adapter: p.adapter as typeof card.adapter,
              label: p.workspaceLabel as string,
              workspaceLabel: p.workspaceLabel as string,
              state: "running",
              goal: String(text).slice(0, 80),
              lastAction: "Leyó tu mensaje",
              pendingApprovals: 0,
              updatedAt: Date.now(),
            };
            db.insert("sessions", {
              owner: OWNER,
              sid,
              device_id: agent.deviceId,
              doc: {
                adapter: p.adapter,
                label: p.workspaceLabel,
                permissionMode: p.permissionMode,
                state: "running",
                card: { ct: await sealToBoth(c, `card:${sid}`) },
              },
              updated_at: iso(Date.now()),
            });
            return;
          }
          case "session.prompt": {
            const text = await open(p.promptCt);
            agentInbox.push({ type: p.type, text });
            await event("message.user", { origin: `client:${me.deviceId}` }, { text });
            await event("message.assistant", {}, { text: `Recibido: ${String(text)}` });
            return session({ state: "running", lastAction: "Leyó tu mensaje" });
          }
          case "session.answer": {
            const answers = await open(p.answerCt);
            agentInbox.push({ type: p.type, text: answers });
            await event("message.user", { origin: `client:${me.deviceId}` }, { text: JSON.stringify(answers) });
            return session({ state: "running", openQuestion: undefined });
          }
          case "session.interrupt":
            return session({ state: "interrupted" });
          case "session.resume":
            if (p.promptCt) agentInbox.push({ type: p.type, text: await open(p.promptCt) });
            return session({ state: "running" });
          case "session.setPermissionMode":
            return session({}, { permissionMode: p.permissionMode });
          case "devmode.off":
            return db.update("devices", (r) => r.device_id === agent.deviceId, {
              dev_mode: { on: false, toggles: [], since: null },
            });
          case "devmode.toggleOff": {
            const d = db.rows("devices").find((r) => r.device_id === agent.deviceId)!;
            const dm = d.dev_mode as { toggles: string[]; since: number | null };
            const toggles = dm.toggles.filter((t) => t !== p.toggle);
            return db.update("devices", (r) => r.device_id === agent.deviceId, {
              dev_mode: toggles.length
                ? { on: true, toggles, since: dm.since }
                : { on: false, toggles: [], since: null },
            });
          }
          case "device.revokeClient":
            // The agent's LOCAL trust list (the server row is /v1/devices/revoke's).
            trusted.delete(p.clientDeviceId as string);
            agentDropped.add(p.clientDeviceId as string);
            return;
        }
      }
    })();
  });

  // ---- this browser's keys (stub of packages/client-keys) ------------------------------
  const agentFingerprint = await fingerprint(agent.sign.publicKey);
  const keys: ClientKeys & { trustedAgents(): TrustedAgent[] } = {
    get deviceId() {
      return me.deviceId;
    },
    get pubBox() {
      return me.pubBox;
    },
    sign: (ctx, body) => signEnvelope(ctx, body, me.deviceId, me.sign.secretKey),
    open: (env, aad) => openJson(env, me.deviceId, me.box, aad),
    seal: async (value, recipients, aad) => {
      const r: Record<string, Uint8Array> = {};
      for (const [id, k] of Object.entries(recipients)) r[id] = await fromB64url(k);
      return sealJson(value, r, aad) as Promise<SealedEnvelope>;
    },
    trustedAgentBoxKey: (id) => (id === agent.deviceId && mePairedWithAgent ? agent.pubBox : null),
    // ADR 0019: the same local-trust rule for the agent's signing key.
    trustedAgentSignKey: (id) => (id === agent.deviceId && mePairedWithAgent ? agent.pubSign : null),
    trustedAgents: () =>
      mePairedWithAgent
        ? [
            {
              deviceId: agent.deviceId,
              pubSign: agent.pubSign,
              pubBox: agent.pubBox,
              fingerprint: agentFingerprint,
              label: "Laptop de Aldo",
              confirmedAt: now,
              via: meAgentVia,
            },
          ]
        : [],
  };

  // ---- sessions: the person's (hub SSO) until this browser signs in as its own device -------
  const personSession = {
    access_token: "dev-person-token",
    user: { id: OWNER, app_metadata: { chalito: { role: "user", tier: "pro" } } },
  };
  const deviceSession = (deviceId: string) => ({
    access_token: `dev-device-token-${deviceId}`,
    user: {
      id: `auth_${deviceId}`,
      app_metadata: { chalito: { role: "client", owner: OWNER, device_id: deviceId } },
    },
  });
  db.setSession(personSession);
  const role = () => (db.session?.user.app_metadata.chalito as { role?: string } | undefined)?.role;

  const controls: Omit<DevControls, "endorse" | "setUsage" | "storeState" | "rooms"> &
    Partial<Pick<DevControls, "endorse" | "setUsage" | "storeState" | "rooms">> = {
    marker: DEV_MARKER,
    owner: OWNER,
    get me() {
      return me.deviceId;
    },
    agent: agent.deviceId,
    other: other.deviceId,
    sid: SID,
    db,
    clientWrites: () => db.clientWrites,
    rows: (t) => db.rows(t),
    seedApproval,
    setDevMode: (on, toggles = on ? ["autoApproveHigh"] : []) =>
      db.update("devices", (r) => r.device_id === agent.deviceId, {
        dev_mode: { on, toggles, since: on ? Date.now() : null },
      }),
    askQuestion: async (questionId, question, options) => {
      await event("question.asked", { questionId }, [
        { question, header: "Pregunta", options: options.map((label) => ({ label })) },
      ]);
      await session({ state: "waiting_input", openQuestion: question });
    },
    agentInbox,
    session: () => (db.session ? { access_token: db.session.access_token, role: role() } : null),
    losePasskey: () => void (currentPasskeyLost = true),
    sleepAgent: () => {
      agentAsleep = true;
      db.update("devices", (r) => r.device_id === agent.deviceId, { last_seen_at: iso(Date.now() - 3_600_000) });
    },
    agentDropped: (id) => agentDropped.has(id),
    wakeAgent: () => {
      agentAsleep = false;
      db.update("devices", (r) => r.device_id === agent.deviceId, { last_seen_at: iso(Date.now()) });
      for (const r of db.rows("devices"))
        if (r.role === "client" && r.revoked) {
          trusted.delete(r.device_id as string);
          agentDropped.add(r.device_id as string);
        }
    },
    revokeMe: () =>
      db.update("devices", (r) => r.device_id === me.deviceId, { revoked: true, revoked_at: iso(Date.now()) }),
  };
  (window as unknown as { __chalitoDev: typeof controls }).__chalitoDev = controls;

  // The api + Twilio Verify, simulated (apps/api/src/phone/routes.ts): /start needs the charges
  // acknowledgement; /check takes 123456, refuses a number on another account, and on success
  // the SERVER stores the verified phone and records the acknowledgement.
  const IN_USE = "+525500000000";
  const user = () => db.rows("users").find((r) => r.id === OWNER)!;
  const phoneVerifier: PhoneVerifier = {
    start: async (e164) => (/^\+[1-9]\d{7,14}$/.test(e164) ? { ok: true } : { ok: false, reason: "invalid" }),
    check: async (e164, code) => {
      if (code !== "123456") return { ok: false, reason: "wrong_code" };
      if (e164 === IN_USE) return { ok: false, reason: "in_use" };
      const at = new Date().toISOString();
      db.update("users", (r) => r.id === OWNER, {
        phone_e164: e164,
        phone_country: e164.startsWith("+81") ? "JP" : e164.startsWith("+52") ? "MX" : "US",
        phone_verified_at: at,
        phone_pending_e164: null,
        charges_notice_ack_at: user().charges_notice_ack_at ?? at,
      });
      return { ok: true };
    },
  };
  // POST /v1/phone/channels: verified phone + acknowledgement to turn anything on; no calls to JP.
  const channels: ChannelSetter = async (patch) => {
    const u = user();
    if (Object.values(patch).some((v) => v === true)) {
      if (!u.phone_verified_at) return { ok: false, reason: "phone_not_verified" };
      if (!u.charges_notice_ack_at) return { ok: false, reason: "charges_notice_required" };
      if (patch.calls === true && u.phone_country === "JP") return { ok: false, reason: "country_not_supported" };
    }
    const next: Row = {};
    if (patch.whatsapp !== undefined) next.whatsapp_opt_in = patch.whatsapp;
    if (patch.calls !== undefined) next.calls_enabled = patch.calls;
    if (patch.sms !== undefined) next.sms_enabled = patch.sms;
    db.clientWrites.push({ table: "api", op: "phone/channels", row: { ...patch } });
    db.update("users", (r) => r.id === OWNER, next);
    return { ok: true };
  };

  // ---- M10 api (apps/api/src/routes/oauth.ts), simulated -------------------------------
  const SCOPES: ConsentRequest["scopes"] = [
    {
      scope: "mcp:read",
      es: "Ver tus aprobaciones pendientes y el estado de tus sesiones.",
      en: "See your pending approvals and session status.",
      defaultChecked: true,
    },
    {
      scope: "approval:recommend",
      es: "Sugerir aprobar o rechazar (solo una sugerencia).",
      en: "Suggest approving or denying (advice only).",
      defaultChecked: true,
    },
    {
      scope: "session:prompt",
      es: "Enviar instrucciones a tus sesiones de agentes.",
      en: "Send prompts to your agent sessions.",
      defaultChecked: false,
    },
  ];
  const requests = new Map<string, ConsentRequest & { redirectUri: string; state: string }>([
    [
      "req_dev_1",
      {
        requestId: "req_dev_1",
        client: {
          name: "Claude",
          id: "https://claude.ai/oauth/mcp-client-metadata",
          redirectHost: "claude.ai",
          provider: "claude",
        },
        scopes: SCOPES,
        expiresAt: Date.now() + 10 * 60 * 1000,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        state: "st_dev",
      },
    ],
  ]);
  const connectors: Connector[] = [
    {
      cid: "con_dev_gpt",
      clientId: "https://chatgpt.com/oauth/client",
      clientName: "ChatGPT",
      provider: "chatgpt",
      scopes: ["mcp:read"],
      createdAt: now - 86_400_000,
      lastUsedAt: now - 3_600_000,
      revokedAt: null,
    },
  ];
  const lastAssertion = { value: null as string | null };
  const mcp: McpApi = {
    getRequest: async (id) => {
      const r = requests.get(id);
      if (!r) return "not_found";
      const { redirectUri: _r, state: _s, ...view } = r;
      return view;
    },
    approve: async (id, scopes, assertion) => {
      if (role() !== "client") return "forbidden"; // requireAuth(["client"])
      const r = requests.get(id);
      if (!r) return "not_found";
      if (!passkeyRef()) return "no_passkey";
      if (assertion.id !== lastAssertion.value) return "passkey_failed";
      if (!scopes.every((x) => r.scopes.some((s) => s.scope === x))) return "error";
      requests.delete(id);
      connectors.push({
        cid: "con_dev_new",
        clientId: r.client.id,
        clientName: r.client.name,
        provider: r.client.provider,
        scopes,
        createdAt: Date.now(),
        lastUsedAt: null,
        revokedAt: null,
      });
      db.clientWrites.push({ table: "api", op: "oauth/approve", row: { id, scopes } });
      return { redirect: `${r.redirectUri}?code=dev_code&state=${r.state}&iss=https%3A%2F%2Fapi.chalito.dev` };
    },
    deny: async (id) => {
      const r = requests.get(id);
      if (!r) return "not_found";
      requests.delete(id);
      return { redirect: `${r.redirectUri}?error=access_denied&state=${r.state}&iss=https%3A%2F%2Fapi.chalito.dev` };
    },
    listConnectors: async () => connectors.map((c) => ({ ...c })),
    revoke: async (cid) => {
      const c = connectors.find((x) => x.cid === cid);
      if (!c) return "not_found";
      c.revokedAt = Date.now();
      db.clientWrites.push({ table: "api", op: "connectors/revoke", row: { cid } });
      return true;
    },
    setSharing: async ({ sessionId, deviceId, enabled, plaintextAck }) => {
      if (role() !== "client") return "forbidden"; // requireAuth(["client"])
      if (!!sessionId === !!deviceId) return "error";
      if (enabled && plaintextAck !== true) return "error";
      const scope = sessionId ? "session" : "device";
      const target = (sessionId ?? deviceId)!;
      db.clientWrites.push({
        table: "api",
        op: "mcp/sharing",
        row: { scope, target, enabled, plaintextAck: !!plaintextAck },
      });
      const match = (r: Row) => r.owner === OWNER && r.scope === scope && r.target === target;
      if (db.rows("mcp_sharing").some(match)) db.update("mcp_sharing", match, { enabled });
      else
        db.insert("mcp_sharing", {
          owner: OWNER,
          scope,
          target,
          enabled,
          plaintext_ack_at: enabled ? new Date().toISOString() : null,
        });
      return true;
    },
  };
  const assertPasskey = async () => {
    if (!passkeyRef()) throw Object.assign(new Error("no passkey"), { name: "NotAllowedError" });
    lastAssertion.value = `dev_assert_${Math.random().toString(36).slice(2)}`;
    return { id: lastAssertion.value, type: "public-key" };
  };

  // ---- /v1/endorse + /v1/devices/endorsed (apps/api), simulated --------------------------
  // The browser runs the real client code (packages/client endorsementChannel, client-keys
  // resolveForEndorsement / approveEndorsement / enrollEndorsed) against these routes.
  interface Code {
    codeId: string;
    shortCode: string;
    registration: DeviceRegistration;
    expiresAt: number;
    endorsement: Endorsement | null;
    taken: boolean;
  }
  const codes = new Map<string, Code>();
  const watchers = new Map<string, Set<() => void>>();
  /** Trusted clients' signing keys (who may endorse): this browser and "Navegador del trabajo". */
  const clients = new Map([
    [me.deviceId, await fromB64url(me.pubSign)],
    [other.deviceId, await fromB64url(other.pubSign)],
  ]);
  const fail = (status: number, code: string) => new ApiError(status, code);
  const needRole = (want: "user" | "client") => {
    if (role() !== want) throw fail(403, "forbidden");
  };
  const live = (c: Code | undefined): Code => {
    if (!c) throw fail(404, "not_found");
    if (c.expiresAt <= Date.now()) throw fail(410, "expired");
    return c;
  };
  const pointer = (codeId: string) => watchers.get(codeId)?.forEach((f) => f());
  const openCode = async (registration: DeviceRegistration): Promise<Code> => {
    const chk = await verifyEnvelope(
      registration,
      "chalito.device-register.v1",
      new Map([[registration.body.deviceId, await fromB64url(registration.body.pubSign)]]),
    );
    if (!chk.ok || registration.body.owner !== OWNER) throw fail(400, "bad_registration");
    const c: Code = {
      codeId: (await randomNonce()).slice(0, 22),
      shortCode: await generateShortCode(),
      registration,
      expiresAt: Date.now() + 5 * 60 * 1000,
      endorsement: null,
      taken: false,
    };
    codes.set(c.codeId, c);
    return c;
  };
  /** Records a signed endorsement on a code, as POST /v1/endorse/approve does after its checks. */
  const endorse = async (c: Code, endorsement: Endorsement, signer: string) => {
    if (c.endorsement) throw fail(409, "already_endorsed");
    const key = clients.get(signer);
    const row = db.rows("devices").find((r) => r.device_id === signer);
    if (!key || !row || row.revoked) throw fail(403, "endorser_not_trusted");
    if (endorsement.signerDeviceId !== signer) throw fail(403, "signer_mismatch");
    const chk = await verifyEnvelope(endorsement, "chalito.endorsement.v1", new Map([[signer, key]]));
    const reg = c.registration.body;
    const b = endorsement.body;
    if (
      !chk.ok ||
      b.uid !== OWNER ||
      b.newDeviceId !== reg.deviceId ||
      b.pubSign !== reg.pubSign ||
      b.pubBox !== reg.pubBox
    )
      throw fail(400, "endorsement_mismatch");
    c.endorsement = endorsement;
    pointer(c.codeId);
  };
  const api: ApiClient = {
    post: async <T>(path: string, body: unknown): Promise<T> => {
      const b = body as Record<string, unknown>;
      db.clientWrites.push({ table: "api", op: path.replace(/^\/v1\//, ""), row: { ...b } });
      if (path.startsWith("/v1/rooms/")) {
        if (role() !== "client") throw fail(403, "forbidden");
        return (await roomsApi(path, b)) as T;
      }
      switch (path) {
        case "/v1/endorse/codes": {
          needRole("user");
          const c = await openCode(b.registration as DeviceRegistration);
          return {
            codeId: c.codeId,
            shortCode: c.shortCode,
            expiresAt: c.expiresAt,
            watchToken: `dev-watch-${c.codeId}`,
          } as T;
        }
        case "/v1/endorse/take": {
          needRole("user");
          const c = live(codes.get(b.codeId as string));
          if (!c.endorsement) throw fail(409, "not_endorsed");
          if (c.taken) throw fail(409, "already_taken");
          c.taken = true;
          return { endorsement: c.endorsement } as T;
        }
        case "/v1/endorse/resolve": {
          needRole("client");
          const c = live(
            "codeId" in b
              ? codes.get(b.codeId as string)
              : [...codes.values()].find((x) => x.shortCode === b.shortCode),
          );
          if (c.endorsement) throw fail(409, "already_endorsed");
          return { codeId: c.codeId, registration: c.registration, expiresAt: c.expiresAt } as T;
        }
        case "/v1/endorse/approve": {
          needRole("client");
          const c = live(codes.get(b.codeId as string));
          if (passkeyRef()) {
            // R-L13: the passkey assertion is inside the signed endorsement body.
            const su = (b.endorsement as { body: { stepUp?: { assertion?: { credentialId?: unknown } } } }).body.stepUp;
            if (!su) throw fail(401, "step_up_required");
            if (su.assertion?.credentialId !== passkeyRef()!.credentialId) throw fail(401, "step_up_failed");
          }
          await endorse(c, b.endorsement as Endorsement, me.deviceId);
          return { ok: true } as T;
        }
        case "/v1/devices/revoke-all": {
          // apps/api/src/routes/devices.ts: passkey mandatory, then revoke + ban every other client
          // and queue the caller's signed revokeClient commands (checked: signer, signature, target).
          needRole("client");
          if (!passkeyRef()) throw fail(403, "passkey_required");
          if (!b.stepUp) throw fail(401, "step_up_required");
          if ((b.stepUp as { id?: unknown }).id !== lastAssertion.value) throw fail(401, "step_up_failed");
          const others = db
            .rows("devices")
            .filter((r) => r.role === "client" && !r.revoked && r.device_id !== me.deviceId)
            .map((r) => String(r.device_id));
          for (const id of others)
            db.update("devices", (r) => r.device_id === id, { revoked: true, revoked_at: iso(Date.now()) });
          const agents = db
            .rows("devices")
            .filter((r) => r.role === "agent" && !r.revoked)
            .map((r) => String(r.device_id));
          let queued = 0;
          const refused: string[] = [];
          for (const cmd of (b.commands as {
            body: { cid: string; targetDeviceId: string; payload: { type: string } };
            signerDeviceId: string;
          }[]) ?? []) {
            const ok =
              cmd.signerDeviceId === me.deviceId &&
              cmd.body.payload.type === "device.revokeClient" &&
              agents.includes(cmd.body.targetDeviceId) &&
              (
                await verifyEnvelope(
                  cmd as never,
                  "chalito.command.v1",
                  new Map([[me.deviceId, await fromB64url(me.pubSign)]]),
                )
              ).ok;
            if (!ok) {
              refused.push(cmd.body.cid);
              continue;
            }
            // Queued for the agent (its own loop picks commands up like any other).
            db.insert("commands", { id: cmd.body.cid, target_device_id: cmd.body.targetDeviceId, env: cmd }, true);
            queued++;
          }
          return { ok: true, revoked: others, agents, commandsQueued: queued, refused, banFailed: [] } as T;
        }
        case "/v1/devices/revoke": {
          needRole("client");
          const id = b.deviceId as string;
          const row = db.rows("devices").find((r) => r.device_id === id);
          if (!row) throw fail(404, "not_found");
          if (row.revoked) return { ok: true, alreadyRevoked: true } as T;
          db.update("devices", (r) => r.device_id === id, { revoked: true, revoked_at: iso(Date.now()) });
          return { ok: true } as T;
        }
        case "/v1/devices/endorsed": {
          needRole("user");
          const reg = b.registration as DeviceRegistration;
          const e = b.endorsement as Endorsement;
          const c = [...codes.values()].find((x) => x.registration.body.deviceId === reg.body.deviceId);
          if (!c?.endorsement || c.endorsement.sig !== e.sig) throw fail(400, "endorsement_mismatch");
          if (db.rows("devices").some((r) => r.device_id === reg.body.deviceId)) throw fail(409, "device_exists");
          const pub = await fromB64url(reg.body.pubSign);
          trusted.set(reg.body.deviceId, pub); // the agent verifies the endorsement locally
          clients.set(reg.body.deviceId, pub);
          db.insert("devices", {
            owner: OWNER,
            device_id: reg.body.deviceId,
            role: "client",
            kind: reg.body.kind,
            platform: reg.body.platform,
            name: reg.body.name,
            revoked: false,
            last_seen_at: iso(Date.now()),
            dev_mode: { on: false, toggles: [], since: null },
            policy_hash: null,
            pub_sign: reg.body.pubSign,
            pub_box: reg.body.pubBox,
            last_event: null,
          });
          window.localStorage.setItem(DEV_PAIRED_KEY, "1");
          const hash = `dev-magiclink-${reg.body.deviceId}-endorsed`;
          db.tokenHashes.set(hash, deviceSession(reg.body.deviceId));
          return { customToken: hash, deviceId: reg.body.deviceId } as T;
        }
      }
      throw fail(404, "not_found");
    },
  };
  // Realtime on chalito:pairing:<codeId>: a pointer on approve, and one on join (resync).
  const endorseWatch: EndorseWatch = async (codeId, _token, onPointer) => {
    const set = watchers.get(codeId) ?? new Set();
    set.add(onPointer);
    watchers.set(codeId, set);
    setTimeout(onPointer, 0);
    return () => set.delete(onPointer);
  };
  controls.endorse = {
    refusedByAgent: (id, reason) => refusedByAgent(id, reason),
    newBrowser: async (name = "Firefox en Linux") => {
      const k = await generateDeviceKeys();
      const registration = await signDeviceRegistration(k, {
        owner: OWNER,
        kind: "web",
        platform: "web",
        name,
        now: Date.now(),
      });
      const c = await openCode(registration);
      return {
        codeId: c.codeId,
        shortCode: c.shortCode,
        deviceId: k.deviceId,
        fingerprint: await fingerprint(k.sign.publicKey),
        glyph: await endorseGlyph(k, c, { label: name, now: Date.now() }),
      };
    },
    endorsementOf: (codeId) => {
      const e = codes.get(codeId)?.endorsement;
      return e
        ? {
            signer: e.signerDeviceId,
            newDeviceId: e.body.newDeviceId,
            agents: (e.body.agents ?? []).map((a) => a.deviceId),
          }
        : null;
    },
    approveFromOther: async (shortCode, introduce = "agent") => {
      const c = live([...codes.values()].find((x) => x.shortCode === shortCode));
      const reg = c.registration.body;
      // ADR 0018: "Navegador del trabajo" introduces the agent it trusts ("tampered": with a wrong box key).
      const introduced =
        introduce === "none"
          ? undefined
          : [
              {
                deviceId: agent.deviceId,
                pubSign: agent.pubSign,
                pubBox: introduce === "tampered" ? other.pubBox : agent.pubBox,
                fingerprint: agentFingerprint,
              },
            ];
      const body = EndorsementBody.parse({
        v: 1,
        uid: OWNER,
        newDeviceId: reg.deviceId,
        pubSign: reg.pubSign,
        pubBox: reg.pubBox,
        issuedAt: Date.now(),
        ...(introduced ? { agents: introduced } : {}),
      });
      const e = (await signEnvelope(
        "chalito.endorsement.v1",
        body,
        other.deviceId,
        other.sign.secretKey,
      )) as Endorsement;
      await endorse(c, e, other.deviceId);
    },
  };
  const refusedByAgent = (clientDeviceId: string, reason: string) =>
    db.update("devices", (r) => r.device_id === agent.deviceId, {
      last_event: {
        v: 1,
        type: "trust.endorsement_refused",
        deviceId: agent.deviceId,
        clientDeviceId,
        endorsedBy: me.deviceId,
        reason,
        t: Date.now(),
      },
    });
  const saveDeviceKeys = async (k: { deviceId: string; sign: SigningKeyPair; box: BoxKeyPair }) => {
    me = { ...k, pubSign: await toB64url(k.sign.publicKey), pubBox: await toB64url(k.box.publicKey) };
    mePairedWithAgent = false;
    meAgentVia = "glyph";
  };
  // ADR 0018: the browser stores the computers its endorser introduced (vetted by the web code).
  const trustIntroduced = async (_k: unknown, agents: { deviceId: string }[], endorsedBy: string) => {
    db.clientWrites.push({
      table: "local",
      op: "trustIntroduced",
      row: { agents: agents.map((a) => a.deviceId), endorsedBy },
    });
    if (agents.some((a) => a.deviceId === agent.deviceId)) {
      mePairedWithAgent = true;
      meAgentVia = "endorsement";
    }
  };

  // ---- GET /v1/usage/daily (apps/orchestrator), simulated: same shape, costs included --------
  let usageMode: "normal" | "over" | "empty" | "error" = "normal";
  controls.setUsage = (m) => void (usageMode = m);
  const usage: UsageApi = async (days) => {
    db.clientWrites.push({ table: "api", op: "usage/daily", row: { days } });
    if (role() !== "client" || usageMode === "error") return "error";
    const n = Math.min(31, Math.max(1, days));
    const DAY = 86_400_000;
    const today = Math.floor(Date.now() / DAY) * DAY;
    const list = Array.from({ length: n }, (_, i) => {
      const day = new Date(today - (n - 1 - i) * DAY).toISOString().slice(0, 10);
      const on = usageMode !== "empty" && i % 7 !== 3; // a quiet day each week
      const work = on ? 40_000 + ((i * 7919) % 25_000) : 0;
      const comms = on ? Math.round(work * (usageMode === "over" ? 0.18 : 0.06)) : 0;
      const byo = on && i % 2 === 0 ? 12_000 + ((i * 104_729) % 9_000) : 0;
      return {
        day,
        managed: {
          work: { tokens: work, costUsdMicros: work * 3 },
          comms: { tokens: comms, costUsdMicros: comms * 3 },
        },
        byo: { tokens: byo, estCostUsdMicros: byo * 3 },
      };
    });
    const sum = (f: (x: (typeof list)[number]) => number) => list.reduce((a, x) => a + f(x), 0);
    const work = sum((x) => x.managed.work.costUsdMicros);
    const comms = sum((x) => x.managed.comms.costUsdMicros);
    return parseUsage({
      days: list,
      totals: {
        managedTokens: sum((x) => x.managed.work.tokens + x.managed.comms.tokens),
        managedCostUsdMicros: work + comms,
        commsCostUsdMicros: comms,
        byoTokens: sum((x) => x.byo.tokens),
      },
      commsOverheadRatio: work + comms > 0 ? comms / (work + comms) : null,
      target: 0.1,
    })!;
  };

  // ---- /v1/store (apps/api/src/store/routes.ts), simulated ------------------------------
  let balance = 300_000;
  let failNext: "hub_unavailable" | "network" | null = null;
  const owned = new Set<string>();
  const purchases: Record<string, { cosmeticId: string; charged: number }> = {};
  const catalogItem = (id: string) =>
    (DEV_CATALOG as Record<string, (typeof DEV_CATALOG)[keyof typeof DEV_CATALOG]>)[id];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const storeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    db.clientWrites.push({ table: "api", op: path.replace(/^\/v1\//, ""), row: { ...body } });
    if (path === "/v1/store/catalog")
      return reply(200, {
        items: Object.entries(DEV_CATALOG).map(([id, x]) => ({ id, ...x, owned: x.free || owned.has(id) })),
      });
    if (path === "/v1/store/purchase") {
      const item = catalogItem(body.cosmeticId as string);
      if (!item) return reply(404, { error: "unknown_cosmetic" });
      if (item.free) return reply(200, { status: "owned", cosmeticId: body.cosmeticId, charged: 0 });
      const prior = purchases[body.purchaseId as string];
      if (prior)
        return reply(200, { status: "owned", cosmeticId: prior.cosmeticId, charged: prior.charged, replay: true });
      if (owned.has(body.cosmeticId as string))
        return reply(200, { status: "owned", cosmeticId: body.cosmeticId, charged: 0 });
      if (failNext) {
        const how = failNext;
        failNext = null;
        if (how === "network") throw new TypeError("Failed to fetch");
        return reply(503, { error: "hub_unavailable" });
      }
      const price = (item as { priceTokens: number }).priceTokens;
      if (balance < price)
        return reply(402, { error: "no_tokens", chips: [{ label: "¿Por qué?", href: "/creditos" }] });
      balance -= price;
      owned.add(body.cosmeticId as string);
      purchases[body.purchaseId as string] = { cosmeticId: body.cosmeticId as string, charged: price };
      return reply(200, { status: "owned", cosmeticId: body.cosmeticId, charged: price });
    }
    if (path === "/v1/store/equip") {
      const { companionId, slot, cosmeticId } = body as {
        companionId: string;
        slot: string;
        cosmeticId: string | null;
      };
      if (cosmeticId !== null) {
        const item = catalogItem(cosmeticId);
        if (!item) return reply(404, { error: "unknown_cosmetic" });
        if (item.slot !== slot) return reply(400, { error: "wrong_slot" });
        if (!item.free && !owned.has(cosmeticId)) return reply(403, { error: "not_owned" });
      }
      const row = db.rows("companions").find((r) => r.owner === OWNER && r.companion_id === companionId);
      if (!row) return reply(404, { error: "unknown_companion" });
      const equipped = { ...((row.equipped as Row) ?? {}) };
      if (cosmeticId === null) delete equipped[slot];
      else equipped[slot] = cosmeticId;
      db.update("companions", (r) => r === row, { equipped });
      return reply(200, { ok: true, slot, cosmeticId });
    }
    return reply(404, { error: "not_found" });
  }) as typeof fetch;
  const store = httpStore("http://dev.invalid", async () => db.session?.access_token ?? null, storeFetch);
  controls.storeState = {
    balance: () => balance,
    setBalance: (n) => void (balance = n),
    failNextPurchase: (how) => void (failNext = how),
    purchases: () => ({ ...purchases }),
    seedCompanion: (avatar) =>
      db.insert("companions", {
        owner: OWNER,
        companion_id: "chl_devcompanionaaaaaaaaaaaaaa",
        name: "Chalito",
        is_renamed: false,
        avatar,
        equipped: {},
      }),
  };

  // ---- /v1/rooms (apps/api/src/routes/rooms.ts), simulated --------------------------------
  const MY_COMPANION = "chl_devcompanionaaaaaaaaaaaaaa";
  const ANA = "chl_anacompanionbbbbbbbbbbbbbb";
  const ROOM = "room_dev_familia";
  const PROJECT = "room_dev_proyecto";
  const INVITE = "KQ7R-M2XZ";
  const roomKeys = new Map<string, Uint8Array>();
  const reports: Row[] = [];
  let inviteUsed = false;
  const ensureCompanion = () => {
    if (!db.rows("companions").some((c) => c.owner === OWNER))
      db.insert("companions", {
        owner: OWNER,
        companion_id: MY_COMPANION,
        name: "Chalito",
        is_renamed: false,
        avatar: "chalito",
        equipped: {},
      });
    return String(db.rows("companions").find((c) => c.owner === OWNER)!.companion_id);
  };
  const makeRoom = async (roomId: string, name: string, owner: string, members: string[]) => {
    const key = await generateRoomKey();
    roomKeys.set(roomId, key);
    db.insert("rooms", { room_id: roomId, type: "family", name, owner_companion_id: owner, key_epoch: 1 });
    for (const m of members)
      db.insert("room_members", { room_id: roomId, companion_id: m, role: m === owner ? "owner" : "member" });
  };
  const keyMe = async (roomId: string, companion: string) => {
    const wrapped = await wrapRoomKeyFor(roomKeys.get(roomId)!, 1, [{ deviceId: me.deviceId, pubBox: me.pubBox }]);
    db.insert("room_member_keys", {
      room_id: roomId,
      companion_id: companion,
      device_id: me.deviceId,
      epoch: 1,
      ct: wrapped[me.deviceId],
    });
  };
  const insertEvent = (
    roomId: string,
    req: { eid: string; companionId: string; kind: string; urgency: string; ct: unknown; keyEpoch: number },
  ) =>
    db.insert("room_events", {
      room_id: roomId,
      eid: req.eid,
      from_companion_id: req.companionId,
      to_companions: [],
      kind: req.kind,
      urgency: req.urgency,
      ct: req.ct,
      key_epoch: req.keyEpoch,
      promoted: false,
      t: iso(Date.now()),
      expires_at: iso(Date.now() + 24 * 3_600_000),
    });
  const postAsAna = async (text: string, roomId = ROOM) => {
    const req = await sealRoomEvent({
      roomId,
      epoch: 1,
      key: roomKeys.get(roomId)!,
      eid: `evt_${Math.random().toString(36).slice(2)}`,
      companionId: ANA,
      body: { kind: "notice", text },
    });
    insertEvent(roomId, req);
    return req.eid;
  };
  const isMember = (roomId: string, companion: string) =>
    db.rows("room_members").some((m) => m.room_id === roomId && m.companion_id === companion);
  const roomsApi = async (path: string, b: Row): Promise<unknown> => {
    if (path === "/v1/rooms/join") {
      if (b.shortCode !== INVITE || inviteUsed) throw fail(404, "invite_not_found");
      inviteUsed = true;
      await makeRoom(PROJECT, "Proyecto", ANA, [ANA]);
      db.insert("room_members", { room_id: PROJECT, companion_id: b.companionId, role: "member" });
      await keyMe(PROJECT, String(b.companionId)); // a member's client wraps the key to the newcomer
      return { roomId: PROJECT };
    }
    const m = /^\/v1\/rooms\/([^/]+)\/(events|leave|reports)$/.exec(path);
    if (!m) throw fail(404, "not_found");
    const roomId = decodeURIComponent(m[1]!);
    if (!isMember(roomId, String(b.companionId))) throw fail(403, "not_a_member");
    if (m[2] === "events") {
      insertEvent(roomId, b as never);
      return { ok: true };
    }
    if (m[2] === "leave") {
      db.remove("room_members", (r) => r.room_id === roomId && r.companion_id === b.companionId);
      db.pointer({ table: "room_members", op: "kicked", key: { companion_id: b.companionId } });
      return {};
    }
    if (reports.length >= 10) throw fail(429, "rate_limited");
    const dup = reports.find(
      (r) => r.roomId === roomId && r.eventId === (b.eventId ?? null) && r.member === (b.memberCompanionId ?? null),
    );
    if (dup) return { reportId: dup.reportId, duplicate: true };
    const r = {
      reportId: `rpt_${reports.length + 1}`,
      roomId,
      eventId: b.eventId ?? null,
      member: b.memberCompanionId ?? null,
      reason: b.reason,
      note: b.note ?? null,
      plaintext: b.attachPlaintext === true ? (b.attachedPlaintext ?? null) : null,
    };
    reports.push(r);
    return { reportId: r.reportId, duplicate: false };
  };
  controls.rooms = {
    seed: async () => {
      const mine = ensureCompanion();
      if (!roomKeys.has(ROOM)) {
        await makeRoom(ROOM, "Familia", mine, [mine, ANA]);
        // Co-members' public card (what the stage draws for another family's companion).
        db.insert("companion_directory", {
          companion_id: ANA,
          display_name: "Luna de Ana",
          avatar_thumb: "luna",
          equipped: ["round_glasses"],
        });
        await keyMe(ROOM, mine);
      }
      const eid = await postAsAna("Llego a las 7, ¿alguien pasa por pan? <b>no es HTML</b>");
      return { roomId: ROOM, me: mine, ana: ANA, eid };
    },
    postAsAna: (text) => postAsAna(text),
    kickMe: () => {
      const mine = ensureCompanion();
      db.remove("room_members", (r) => r.room_id === ROOM && r.companion_id === mine);
      db.pointer({ table: "room_members", op: "kicked", key: { companion_id: mine } });
    },
    dissolve: () => {
      db.remove("rooms", (r) => r.room_id === ROOM);
      db.pointer({ table: "rooms", op: "dissolve" });
    },
    inviteCode: INVITE,
    reports: () => reports.map((r) => ({ ...r })),
  };

  // DEV/TEST: start with the seeded room ("chalito.dev.rooms" = "1"), so a page load lands in it.
  try {
    if (window.localStorage.getItem("chalito.dev.rooms") === "1") await controls.rooms.seed();
  } catch {
    /* storage unavailable */
  }

  // /v1/devices/token, simulated: the signature over the refresh challenge is the authentication.
  const sb = db.client(OWNER);
  return {
    controls: controls as DevControls,
    db: sb,
    url: "http://dev.invalid",
    publishableKey: "dev",
    loadDeviceKeys: async () =>
      devPaired()
        ? {
            keys: keys as ClientKeys & {
              sign: typeof keys.sign;
              deviceId: string;
              trustedAgents: () => TrustedAgent[];
            },
            // Like client-keys' passkeyStepUp: nothing without an enrolled passkey.
            stepUp: async ({ risk }) =>
              passkeyRef() && (await confirmStepUp(risk)) ? { method: "platform_biometric", at: Date.now() } : null,
            forget: async () => window.localStorage.setItem(DEV_PAIRED_KEY, "0"),
            roomKeyring: (rows: readonly { epoch: number; ct: string }[]) => unwrapKeyring(rows, me.box),
          }
        : null,
    deviceLogin: (k, owner) => async () => {
      const body = { v: 1 as const, owner, deviceId: k.deviceId, nonce: "n".repeat(22), issuedAt: Date.now() };
      const challenge = await k.sign("chalito.refresh-challenge.v1", body);
      const ok = await verifyEnvelope(challenge as never, "chalito.refresh-challenge.v1", trusted);
      const row = db.rows("devices").find((r) => r.device_id === k.deviceId);
      if (!row || row.revoked !== false)
        throw Object.assign(new Error("device_revoked"), { status: 403, code: "device_revoked" });
      if (!ok.ok) throw Object.assign(new Error("bad_signature"), { status: 401, code: "bad_signature" });
      const hash = `dev-magiclink-${k.deviceId}-${Math.random().toString(36).slice(2)}`;
      db.tokenHashes.set(hash, deviceSession(k.deviceId));
      db.clientWrites.push({ table: "api", op: "devices/token", row: { deviceId: k.deviceId } });
      return hash;
    },
    phone: () => ({ verifier: phoneVerifier, channels }),
    mcp: () => mcp,
    api: () => api,
    usage: () => usage,
    store: () => store,
    endorseWatch,
    saveDeviceKeys,
    trustIntroduced,
    // The dev authenticator: a stand-in assertion over the challenge (the mock api checks the id).
    passkeyAssertion: (ref) => async (challenge) => ({
      credentialId: ref.credentialId,
      authenticatorData: "ZGV2",
      clientDataJSON: await toB64url(
        new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: await toB64url(challenge) })),
      ),
      signature: "ZGV2",
    }),
    // /v1/webauthn/register, simulated with R-M11's rule: replacing needs the current passkey.
    enrollPasskey: async () => {
      const current = passkeyRef();
      db.clientWrites.push({ table: "api", op: "webauthn/register", row: { replace: current !== null } });
      if (current && currentPasskeyLost)
        throw Object.assign(new Error("current_passkey_failed"), { status: 401, code: "current_passkey_failed" });
      savePasskeyRef({ credentialId: current ? "dev-passkey-2" : "dev-passkey", rpId: window.location.hostname });
    },
    assertPasskey: () => assertPasskey(),
  };
};
