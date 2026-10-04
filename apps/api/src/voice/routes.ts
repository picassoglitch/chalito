import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { VoiceProvider } from "@chalito/adapters/voice";
import { sweepVoiceSessions, type VoiceEventFor, type VoiceSessionStore } from "@chalito/billing";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import type { VoiceCap } from "./caps.js";
import type { HubUsage } from "./hub.js";
import { DESKTOP_TOOLS } from "./tools.js";

export interface VoiceDeps {
  provider: VoiceProvider;
  hub: HubUsage;
  /** models.yaml voice.desktop.model */
  model: string;
  voiceName: string;
  /** Signs the voice token heartbeats carry. */
  tokenSecret: string;
  /** Client secret lifetime: just long enough to connect (ADR 0005: 60 s; at most 600 s). */
  ttlSec?: number;
  /** Monthly voice minutes from the plan. Unset: not enforced. */
  cap?: VoiceCap;
  /** Server-side session metering (R-H6): what is billed, whatever the client reports. */
  sessions: VoiceSessionStore;
  /** The longest one session may run (default 30 min); the cap's remaining minutes lower it. */
  maxSessionSec?: number;
}

/** Heartbeats report at most this many seconds each (the desktop beats every 30 s). */
const MAX_BEAT_SEC = 60;
const DEFAULT_MAX_SESSION_SEC = 30 * 60;

interface VoiceToken {
  admissionId: string;
  owner: string;
  deviceId: string;
  sourceId: string;
}

const sign = (secret: string, t: VoiceToken) => {
  const body = Buffer.from(JSON.stringify(t)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`chalito.voice.v1.${body}`).digest("base64url")}`;
};
const verify = (secret: string, token: string): VoiceToken | null => {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(createHmac("sha256", secret).update(`chalito.voice.v1.${body}`).digest("base64url"));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as VoiceToken;
  } catch {
    return null;
  }
};

const Beat = z.object({ voiceToken: z.string().max(2048), seconds: z.number().int().min(0).max(MAX_BEAT_SEC) });

const PERSONA =
  "Eres el compañero de Chalito del usuario, en su escritorio. Responde en el idioma del usuario (español por defecto), cálido y breve. " +
  "Nunca apruebes ni niegues nada: para una aprobación usa open_approval y pide al usuario que la firme en la app.";

/**
 * Desktop push-to-talk (ADR 0005): an active paired device gets an ephemeral OpenAI client secret
 * and talks to OpenAI over WebRTC directly (audio never transits Chalito). Every session is
 * admitted by the hub first and metered as voice.seconds from heartbeats.
 */
export const voiceRoutes = (deps: Deps, voice: VoiceDeps) => {
  const app = new Hono<AuthEnv>();
  // Devices only: requireAuth also refuses revoked devices.
  const auth = requireAuth(deps, ["client", "agent"]);
  const ttlSec = Math.min(600, Math.max(10, voice.ttlSec ?? 60));

  /** The event for one billed increment: source_id `<session>:<total>`, so retries are the same event. */
  const eventFor: VoiceEventFor = (sess, seconds, total) =>
    voice.hub.event({
      owner: sess.owner,
      admissionId: sess.reservationId,
      kind: "voice.seconds",
      seconds,
      sourceId: `${sess.sourceId}:${total}`,
    });
  const settle = (owner: string, reservationId: string) => voice.hub.settle({ owner, admissionId: reservationId });

  app.post("/session", auth, rateLimit({ capacity: 10, refillPerSec: 0.1, now: deps.now }), async (c) => {
    const p = principal(c);
    const now = deps.now();
    // A session left open past its maximum is billed in full before another can start.
    await sweepVoiceSessions({
      store: voice.sessions,
      now,
      owner: p.owner,
      event: eventFor,
      settle: (rid) => settle(p.owner, rid),
    });
    let maxSeconds = Math.max(1, voice.maxSessionSec ?? DEFAULT_MAX_SESSION_SEC);
    if (voice.cap) {
      const cap = await voice.cap.status(p.owner, now);
      if (cap.usedSeconds >= cap.limitSeconds) {
        await voice.cap.note(p.owner, now);
        return fail(402, "voice_cap_reached", "This month's voice minutes are used up.");
      }
      maxSeconds = Math.min(maxSeconds, cap.limitSeconds - cap.usedSeconds);
    }
    const sourceId = `voice_${randomUUID().replace(/-/g, "")}`;
    const admit = await voice.hub.admit({
      owner: p.owner,
      kind: "voice.seconds",
      class: "stream",
      sourceId,
      reserveSeconds: maxSeconds,
    });
    if (!admit.admitted) return fail(402, "voice_not_admitted", admit.reason);
    const opened = await voice.sessions.open({
      sourceId,
      owner: p.owner,
      channel: "desktop",
      deviceId: p.deviceId!,
      reservationId: admit.admissionId,
      model: voice.model,
      startedAt: now,
      maxSeconds,
    });
    if (opened === "busy") {
      await settle(p.owner, admit.admissionId);
      return fail(409, "voice_session_open", "Another voice session is still open; end it first.");
    }
    const secret = await voice.provider.mintClientSecret({
      ttlSec,
      // A stable, non-reversible id for OpenAI's abuse monitoring (never the raw uid).
      safetyIdentifier: createHash("sha256").update(`chalito:${p.owner}`).digest("hex"),
      session: { model: voice.model, voice: voice.voiceName, instructions: PERSONA, tools: DESKTOP_TOOLS },
    });
    await deps.audit.record({ action: "voice.session", owner: p.owner, actor: p.uid, target: sourceId });
    return c.json(
      {
        clientSecret: secret.value,
        expiresAt: secret.expiresAt,
        model: voice.model,
        maxSeconds,
        voiceToken: sign(voice.tokenSecret, {
          admissionId: admit.admissionId,
          owner: p.owner,
          deviceId: p.deviceId!,
          sourceId,
        }),
      },
      201,
    );
  });

  /**
   * Heartbeats and the end bill the server-observed time since the session was minted (capped at
   * its maximum), never `seconds` from the client, which is only a liveness signal now (R-H6).
   */
  const beat = async (c: Context<AuthEnv>, end: boolean) => {
    const p = principal(c);
    const body = Beat.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const t = verify(voice.tokenSecret, body.data.voiceToken);
    if (!t || t.owner !== p.owner || t.deviceId !== p.deviceId) return fail(403, "bad_voice_token");
    const now = deps.now();
    const r = await voice.sessions.advance({ owner: t.owner, sourceId: t.sourceId, now, end, event: eventFor });
    if (!r.found) return fail(404, "voice_session_unknown");
    if (end) {
      await settle(t.owner, t.admissionId);
      return c.json({ ok: true, continue: false, billedSeconds: r.total });
    }
    if (r.ended) return c.json({ ok: true, continue: false, billedSeconds: r.total });
    const alive =
      r.total < r.maxSeconds
        ? await voice.hub.keepAlive({ owner: t.owner, admissionId: t.admissionId, sourceId: t.sourceId })
        : { continue: false };
    let underCap = true;
    if (voice.cap) {
      const cap = await voice.cap.status(t.owner, now);
      underCap = cap.usedSeconds < cap.limitSeconds;
      if (!underCap) await voice.cap.note(t.owner, now);
    }
    return c.json({ ok: true, continue: alive.continue && underCap && r.total < r.maxSeconds, billedSeconds: r.total });
  };
  app.post("/session/heartbeat", auth, (c) => beat(c, false));
  app.post("/session/end", auth, (c) => beat(c, true));
  return app;
};
