import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PAIRING_LOOPBACK_PORTS, PairingCodeId, PairingNonce } from "@chalito/protocol";

/**
 * The unpaired agent's loopback endpoint (ADR 0028 §4, owner decision #52). The approval page in
 * the browser on THIS computer posts {codeId, nonce} to http://127.0.0.1:<port>/pairing/proof; the
 * agent signs (code id, nonce, page origin) with its pairing key, and the page hands that proof to
 * /v1/pairing/claim for one tap. A browser elsewhere can't reach it (127.0.0.1 only), a page of
 * another site is refused (exact Origin), and the nonce is the api's, issued to that browser.
 *
 * Only while a pairing waits; only the hub's origin; Host must be the loopback address (DNS
 * rebinding); small bodies; a global rate limit. Chrome's Private Network Access preflight is
 * answered (`Access-Control-Allow-Private-Network: true`). Safari and others that block loopback
 * from a public page simply fall back to typing the code.
 */

/** Set by scripts/build.ts for compiled (release) agents: only the production hub is accepted. */
declare const __CHALITO_RELEASE__: boolean | undefined;
const RELEASE = typeof __CHALITO_RELEASE__ !== "undefined" && __CHALITO_RELEASE__ === true;

export const HUB_ORIGIN = "https://www.chalyb.com";

/** The origins the proof may be asked from: the hub, plus local or preview hubs in dev builds only. */
export const loopbackOrigins = (env: Record<string, string | undefined>, release: boolean = RELEASE): Set<string> => {
  const out = new Set([HUB_ORIGIN]);
  if (release) return out;
  for (const raw of [env.CHALITO_WEB_BASE, ...(env.CHALITO_LOOPBACK_ORIGINS ?? "").split(",")]) {
    try {
      if (raw?.trim()) out.add(new URL(raw.trim()).origin);
    } catch {
      /* not a URL */
    }
  }
  return out;
};

export type Prove = (codeId: string, nonce: string, origin: string) => Promise<unknown | null>;

export interface PairingLoopback {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY = 1024;

export const startPairingLoopback = async (opts: {
  prove: Prove;
  origins: Set<string>;
  ports?: readonly number[];
  now?: () => number;
  /** Requests per minute across all callers. */
  perMinute?: number;
}): Promise<PairingLoopback | null> => {
  const now = opts.now ?? Date.now;
  const perMinute = opts.perMinute ?? 20;
  let tokens = perMinute;
  let at = now();
  const take = () => {
    const t = now();
    tokens = Math.min(perMinute, tokens + ((t - at) / 60_000) * perMinute);
    at = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  let port = 0;
  const send = (res: ServerResponse, status: number, body?: unknown, origin?: string) => {
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Cache-Control", "no-store");
    if (body === undefined) return void res.writeHead(status).end();
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin ?? "";
    const allowed = opts.origins.has(origin);
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    if (!hostOk) return send(res, 421);
    if (req.url !== "/pairing/proof") return send(res, 404);
    if (!allowed) return send(res, 403);
    if (!take()) return send(res, 429, { error: "rate_limited" }, origin);
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Max-Age", "60");
      if (req.headers["access-control-request-private-network"] === "true")
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      return send(res, 204, undefined, origin);
    }
    if (req.method !== "POST") return send(res, 405, undefined, origin);
    let raw = "";
    for await (const chunk of req) {
      raw += String(chunk);
      if (raw.length > MAX_BODY) return send(res, 413, undefined, origin);
    }
    let body: { codeId?: unknown; nonce?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return send(res, 400, { error: "bad_request" }, origin);
    }
    const codeId = PairingCodeId.safeParse(body.codeId);
    const nonce = PairingNonce.safeParse(body.nonce);
    if (!codeId.success || !nonce.success) return send(res, 400, { error: "bad_request" }, origin);
    const proof = await opts.prove(codeId.data, nonce.data, origin);
    if (!proof) return send(res, 409, { error: "not_waiting" }, origin);
    return send(res, 200, { proof }, origin);
  };

  for (const p of opts.ports ?? PAIRING_LOOPBACK_PORTS) {
    const server: Server = createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) send(res, 500);
      });
    });
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(p, "127.0.0.1", () => resolve(true));
    });
    if (!ok) continue;
    port = (server.address() as { port: number }).port;
    return {
      port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
  return null;
};
