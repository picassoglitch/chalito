import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { VoiceProvider } from "@chalito/adapters/voice";
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
}

/** Heartbeats report at most this many seconds each (the desktop beats every 30 s). */
const MAX_BEAT_SEC = 60;

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

  app.post("/session", auth, rateLimit({ capacity: 10, refillPerSec: 0.1, now: deps.now }), async (c) => {
    const p = principal(c);
    if (voice.cap) {
      const c = await voice.cap.status(p.owner, deps.now());
      if (c.usedSeconds >= c.limitSeconds) {
        await voice.cap.note(p.owner, deps.now());
        return fail(402, "voice_cap_reached", "This month's voice minutes are used up.");
      }
    }
    const sourceId = `voice_${randomUUID().replace(/-/g, "")}`;
    const admit = await voice.hub.admit({ owner: p.owner, kind: "voice.seconds", class: "stream", sourceId });
    if (!admit.admitted) return fail(402, "voice_not_admitted", admit.reason);
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

  const beat = async (c: Context<AuthEnv>, end: boolean) => {
    const p = principal(c);
    const body = Beat.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const t = verify(voice.tokenSecret, body.data.voiceToken);
    if (!t || t.owner !== p.owner || t.deviceId !== p.deviceId) return fail(403, "bad_voice_token");
    const r =
      body.data.seconds > 0
        ? await voice.hub.record({
            owner: t.owner,
            admissionId: t.admissionId,
            kind: "voice.seconds",
            quantity: body.data.seconds,
            sourceId: t.sourceId,
          })
        : { continue: true };
    if (end) await voice.hub.settle({ owner: t.owner, admissionId: t.admissionId });
    let underCap = true;
    if (voice.cap && !end) {
      const cap = await voice.cap.status(t.owner, deps.now());
      underCap = cap.usedSeconds < cap.limitSeconds;
      if (!underCap) await voice.cap.note(t.owner, deps.now());
    }
    return c.json({ ok: true, continue: r.continue && underCap && !end });
  };
  app.post("/session/heartbeat", auth, (c) => beat(c, false));
  app.post("/session/end", auth, (c) => beat(c, true));
  return app;
};
