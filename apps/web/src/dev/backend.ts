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
  deriveDeviceId,
  fromB64url,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  sealJson,
  signEnvelope,
  toB64url,
  verifyEnvelope,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import type { ClientKeys, ConnectOptions } from "@chalito/client";
import { memoryStorage } from "@chalito/client";
import type { SealedEnvelope } from "@chalito/protocol";
import type { PhoneVerifier } from "@chalito/ui";
import type { SettingsDb } from "@/lib/settings-store";
import { confirmStepUp } from "@/components/StepUpHost";
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
  }): Promise<void>;
  setDevMode(on: boolean, toggles?: string[]): void;
  askQuestion(questionId: string, question: string, options: string[]): Promise<void>;
  /** What the agent received, opened with its key (prompts, answers). */
  agentInbox: { type: string; text?: unknown }[];
}

export const startDevBackend = async (): Promise<{
  connectOptions: ConnectOptions;
  phoneVerifier: PhoneVerifier;
  settingsDb: SettingsDb;
  controls: DevControls;
}> => {
  const db = new FakeDb();
  const me = await newDevice();
  const agent = await newDevice();
  const now = Date.now();
  const agentInbox: DevControls["agentInbox"] = [];

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
  device(me, "client", "Este teléfono", "phone", "ios");
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

  const seedApproval: DevControls["seedApproval"] = async ({ aid, risk, ttlMs = 10 * 60 * 1000, summary }) => {
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
      details_ct: await sealToBoth(
        {
          v: 1,
          toolName: risk === "HIGH" ? "Bash" : "Write",
          summary: summary ?? (risk === "HIGH" ? "Bash: rm -rf dist" : "Write: notes.txt"),
          reasons: risk === "HIGH" ? ["deletes files"] : [],
        },
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
        };
        const a = db.rows("approvals").find((r) => r.aid === body.aid);
        if (
          !check.ok ||
          !a ||
          a.status !== "pending" ||
          a.request_id !== body.requestId ||
          body.expiresAt <= Date.now()
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
        const env = w.row.env as Parameters<typeof verifyEnvelope>[0];
        const check = await verifyEnvelope(env, "chalito.command.v1", trusted);
        db.remove("commands", (r) => r.id === w.row.id); // the agent consumes its commands
        if (!check.ok) return;
        const body = env.body as { cid: string; payload: Row & { type: string } };
        const p = body.payload;
        const open = (ct: unknown) => openJson(ct as SealedEnvelope, agent.deviceId, agent.box, `command:${body.cid}`);
        switch (p.type) {
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
            return db.update("devices", (r) => r.device_id === p.clientDeviceId, {
              revoked: true,
              revoked_at: iso(Date.now()),
            });
        }
      }
    })();
  });

  // ---- this browser's keys (stub of packages/client-keys) ------------------------------
  const keys: ClientKeys = {
    deviceId: me.deviceId,
    pubBox: me.pubBox,
    sign: (ctx, body) => signEnvelope(ctx, body, me.deviceId, me.sign.secretKey),
    open: (env, aad) => openJson(env, me.deviceId, me.box, aad),
    seal: async (value, recipients, aad) => {
      const r: Record<string, Uint8Array> = {};
      for (const [id, k] of Object.entries(recipients)) r[id] = await fromB64url(k);
      return sealJson(value, r, aad) as Promise<SealedEnvelope>;
    },
    trustedAgentBoxKey: (id) => (id === agent.deviceId ? agent.pubBox : null),
  };

  const controls: DevControls = {
    marker: DEV_MARKER,
    owner: OWNER,
    me: me.deviceId,
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
  };
  (window as unknown as { __chalitoDev: DevControls }).__chalitoDev = controls;

  // The api + Twilio Verify, simulated: code 123456; on success the SERVER writes the verified phone.
  const phoneVerifier: PhoneVerifier = {
    start: async (e164) => (/^\+[1-9]\d{6,14}$/.test(e164) ? { ok: true } : { ok: false, reason: "invalid" }),
    check: async (e164, code) => {
      if (code !== "123456") return { ok: false, reason: "wrong_code" };
      db.update("users", (r) => r.id === OWNER, {
        phone_e164: e164,
        phone_verified_at: new Date().toISOString(),
        phone_pending_e164: null,
      });
      return { ok: true };
    },
  };

  return {
    phoneVerifier,
    controls,
    settingsDb: db.client({ access_token: "dev-access" }, OWNER) as unknown as SettingsDb,
    connectOptions: {
      url: "http://dev.invalid",
      publishableKey: "dev",
      keys,
      owner: OWNER,
      storage: memoryStorage(),
      stepUp: async ({ risk }) =>
        (await confirmStepUp(risk)) ? { method: "platform_biometric", at: Date.now() } : null,
      signIn: { kind: "sso", exchange: async () => ({ token_hash: "dev" }) },
      create: () => db.client({ access_token: "dev-access" }, OWNER),
    },
  };
};
