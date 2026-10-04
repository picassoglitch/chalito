/**
 * Read-mostly smoke test against a DEPLOYED Chalito environment (docs/GO_LIVE.md Phase 7).
 * Never run by CI, never by an agent: the owner (or ops) runs it by hand after a deploy.
 *
 *   CHALITO_SMOKE_TARGET=staging CHALITO_SMOKE_CONFIRM=yes \
 *   CHALITO_API_URL=https://api.chalito.chalyb.com CHALITO_NOTIFIER_URL=https://… \
 *   CHALITO_ORCHESTRATOR_URL=https://… CHALITO_MCP_URL=https://mcp.chalito.chalyb.com \
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=… \
 *   pnpm tsx scripts/staging-smoke.ts
 *
 * Optional:
 *   CHALITO_SMOKE_HUB_TOKEN     a fresh hub launch token (single use) for the SSO round trip
 *   CHALITO_SMOKE_DRAIN_BEARER  a Google ID token of the scheduler service account (audience =
 *                               <notifier>/tasks/drain-usage), to run one usage drain like the
 *                               scheduler does; without it, only the route's auth is checked
 *
 * What it writes: one pairing code (expires within 5 minutes; its watcher user is purged by
 * pg_cron), one SSO exchange if a token is given, and at most one drain. Nothing else.
 * Workspace packages are imported by path and supabase-js is resolved from apps/agent.
 */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { generateBoxKeyPair, generateSigningKeyPair, randomNonce, toB64url } from "../packages/crypto/src/index.js";
import { signGlyph } from "../packages/glyph/src/index.js";

type Status = "PASS" | "FAIL" | "SKIP" | "WARN";
const results: { check: string; status: Status; detail: string; ms?: number }[] = [];
const record = (check: string, status: Status, detail: string, ms?: number) =>
  results.push({ check, status, detail, ...(ms === undefined ? {} : { ms: Math.round(ms) }) });

const die = (s: string): never => {
  process.stderr.write(`staging-smoke: ${s}\n`);
  process.exit(2);
};

// ---- refuse unless explicitly aimed and confirmed ---------------------------------
if (process.env.CI) die("refusing to run in CI");
const target = process.env.CHALITO_SMOKE_TARGET;
if (!target) die("set CHALITO_SMOKE_TARGET (a name for the environment you are testing, e.g. staging)");
if (process.env.CHALITO_SMOKE_CONFIRM !== "yes")
  die(`set CHALITO_SMOKE_CONFIRM=yes to run against "${target}" (it mints a pairing code there)`);
const url = (name: string, required = true) => {
  const v = process.env[name]?.replace(/\/$/, "");
  if (!v && required) die(`${name} is required`);
  if (v && !/^https:\/\//.test(v) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(v))
    die(`${name} must be https (or local): ${v}`);
  return v ?? "";
};
const API = url("CHALITO_API_URL");
const NOTIFIER = url("CHALITO_NOTIFIER_URL", false);
const ORCHESTRATOR = url("CHALITO_ORCHESTRATOR_URL", false);
const MCP = url("CHALITO_MCP_URL", false);
const SUPABASE_URL = url("SUPABASE_URL", false);
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

const timed = async <T>(fn: () => Promise<T>) => {
  const t0 = performance.now();
  const v = await fn();
  return { v, ms: performance.now() - t0 };
};
const get = (u: string, init: RequestInit = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(10_000) });

// ---- 1. health --------------------------------------------------------------------
const health = async (name: string, base: string) => {
  if (!base) return record(`${name} /healthz`, "SKIP", "no URL given");
  try {
    const { v: res, ms } = await timed(() => get(`${base}/healthz`));
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    record(`${name} /healthz`, res.ok && body?.ok === true ? "PASS" : "FAIL", `HTTP ${res.status}`, ms);
  } catch (err) {
    record(`${name} /healthz`, "FAIL", err instanceof Error ? err.message : "error");
  }
};

// ---- 2. OAuth metadata (api authorization server, gateway protected resource) ------
const oauthMetadata = async () => {
  try {
    const as = await get(`${API}/.well-known/oauth-authorization-server`);
    const asJson = (await as.json().catch(() => null)) as { issuer?: string; token_endpoint?: string } | null;
    record(
      "api OAuth AS metadata",
      as.ok && !!asJson?.issuer && !!asJson.token_endpoint ? "PASS" : "FAIL",
      as.ok ? `issuer ${asJson?.issuer}` : `HTTP ${as.status}`,
    );
    if (!MCP) return record("gateway protected-resource metadata", "SKIP", "no CHALITO_MCP_URL");
    const pr = await get(`${MCP}/.well-known/oauth-protected-resource`);
    const prJson = (await pr.json().catch(() => null)) as {
      resource?: string;
      authorization_servers?: string[];
    } | null;
    const linked = !!asJson?.issuer && (prJson?.authorization_servers ?? []).includes(asJson.issuer);
    record(
      "gateway protected-resource metadata",
      pr.ok && !!prJson?.resource && linked ? "PASS" : "FAIL",
      pr.ok ? `resource ${prJson?.resource}; points at the api issuer: ${linked}` : `HTTP ${pr.status}`,
    );
  } catch (err) {
    record("OAuth metadata", "FAIL", err instanceof Error ? err.message : "error");
  }
};

// ---- supabase-js (for the SSO session and the Realtime join) ------------------------
const requireFromAgent = createRequire(new URL("../apps/agent/package.json", import.meta.url));
/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK is loaded dynamically, untyped here */
const supabase = async (): Promise<any> =>
  (await import(pathToFileURL(requireFromAgent.resolve("@supabase/supabase-js")).href)) as any;
const sessionFromTokenHash = async (tokenHash: string) => {
  const { createClient } = await supabase();
  const auth = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await auth.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error || !data.session) throw new Error(`verifyOtp: ${error?.message ?? "no session"}`);
  return data.session.access_token as string;
};

// ---- 3. SSO round trip (optional) ---------------------------------------------------
const sso = async () => {
  const token = process.env.CHALITO_SMOKE_HUB_TOKEN;
  if (!token) return record("SSO round trip", "SKIP", "no CHALITO_SMOKE_HUB_TOKEN");
  try {
    const { v: res, ms } = await timed(() =>
      get(`${API}/sso/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
    );
    const body = (await res.json().catch(() => null)) as {
      customToken?: string;
      owner?: string;
      error?: string;
    } | null;
    if (!res.ok || !body?.customToken)
      return record("SSO round trip", "FAIL", `HTTP ${res.status} ${body?.error ?? ""}`, ms);
    if (!SUPABASE_URL || !SUPABASE_KEY)
      return record("SSO round trip", "WARN", "exchange OK; no SUPABASE_URL/KEY to open the session", ms);
    await sessionFromTokenHash(body.customToken);
    record("SSO round trip", "PASS", `exchange + Supabase session for ${body.owner}`, ms);
  } catch (err) {
    record("SSO round trip", "FAIL", err instanceof Error ? err.message : "error");
  }
};

// ---- 4 + 5. pairing code mint, then the Realtime join on its topic --------------------
const pairingAndRealtime = async () => {
  let created: { shortCode: string; watchToken: string; expiresAt: number } | null = null;
  let codeId = "";
  try {
    const sign = await generateSigningKeyPair();
    const box = await generateBoxKeyPair();
    const now = Date.now();
    codeId = await randomNonce();
    const glyph = await signGlyph(
      {
        v: 1,
        purpose: "pair_device",
        codeId,
        issuerPubSign: await toB64url(sign.publicKey),
        issuerPubBox: await toB64url(box.publicKey),
        label: `smoke ${target}`.slice(0, 40),
        issuedAt: now,
        expiresAt: now + 2 * 60_000,
        nonce: await randomNonce(),
      },
      sign.secretKey,
    );
    const { v: res, ms } = await timed(() =>
      get(`${API}/v1/pairing/codes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ glyph, kind: "desktop", platform: "linux" }),
      }),
    );
    const body = (await res.json().catch(() => null)) as typeof created & { error?: string };
    if (res.status !== 201 || !body?.shortCode) {
      record("pairing code mint", "FAIL", `HTTP ${res.status} ${body?.error ?? ""}`, ms);
      return record("realtime join", "SKIP", "no pairing code");
    }
    created = body;
    record("pairing code mint", "PASS", `expires in ${Math.round((body.expiresAt - Date.now()) / 1000)} s`, ms);
    record("pairing code cancel", "PASS", "no cancel route: the code expires in ≤ 2 min, pg_cron purges its watcher");
  } catch (err) {
    record("pairing code mint", "FAIL", err instanceof Error ? err.message : "error");
    return record("realtime join", "SKIP", "no pairing code");
  }

  if (!SUPABASE_URL || !SUPABASE_KEY)
    return record("realtime join", "SKIP", "no SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY");
  try {
    const access = await sessionFromTokenHash(created.watchToken);
    const { createClient } = await supabase();
    const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      accessToken: async () => access,
    });
    await client.realtime.setAuth();
    const t0 = performance.now();
    const status = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("TIMED_OUT"), 10_000);
      client.channel(`chalito:pairing:${codeId}`, { config: { private: true } }).subscribe((s: string) => {
        if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "CLOSED") {
          clearTimeout(timer);
          resolve(s);
        }
      });
    });
    const ms = performance.now() - t0;
    await client.removeAllChannels();
    record(
      "realtime join",
      status !== "SUBSCRIBED" ? "FAIL" : ms > 2000 ? "WARN" : "PASS",
      status === "SUBSCRIBED" ? `chalito:pairing:<code> joined` : status,
      ms,
    );
  } catch (err) {
    record("realtime join", "FAIL", err instanceof Error ? err.message : "error");
  }
};

// ---- 6. usage drain -----------------------------------------------------------------
const drain = async () => {
  if (!NOTIFIER) return record("usage drain", "SKIP", "no CHALITO_NOTIFIER_URL");
  try {
    const unauth = await get(`${NOTIFIER}/tasks/drain-usage`, { method: "POST" });
    if (unauth.status !== 401)
      return record("usage drain auth", "FAIL", `unauthenticated drain got HTTP ${unauth.status}, not 401`);
    record("usage drain auth", "PASS", "refused without the scheduler's OIDC token");
    const bearer = process.env.CHALITO_SMOKE_DRAIN_BEARER;
    if (!bearer) return record("usage drain run", "SKIP", "no CHALITO_SMOKE_DRAIN_BEARER");
    const { v: res, ms } = await timed(() =>
      get(`${NOTIFIER}/tasks/drain-usage`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } }),
    );
    const body = (await res.json().catch(() => null)) as Record<string, number> | null;
    record(
      "usage drain run",
      res.ok && body && (body.dead ?? 0) === 0 ? "PASS" : res.ok ? "WARN" : "FAIL",
      res.ok ? JSON.stringify(body) : `HTTP ${res.status}`,
      ms,
    );
  } catch (err) {
    record("usage drain", "FAIL", err instanceof Error ? err.message : "error");
  }
};

// ---- run, print the table, exit non-zero on any FAIL ----------------------------------
await Promise.all([
  health("api", API),
  health("notifier", NOTIFIER),
  health("orchestrator", ORCHESTRATOR),
  health("mcp-gateway", MCP),
]);
await oauthMetadata();
await sso();
await pairingAndRealtime();
await drain();

const w = Math.max(...results.map((r) => r.check.length));
process.stdout.write(`\nChalito smoke: ${target}\n\n`);
for (const r of results)
  process.stdout.write(
    `${r.status.padEnd(5)} ${r.check.padEnd(w)}  ${r.ms === undefined ? "".padStart(7) : `${r.ms} ms`.padStart(7)}  ${r.detail}\n`,
  );
const failed = results.filter((r) => r.status === "FAIL").length;
process.stdout.write(`\n${failed ? `${failed} failed` : "all passed"} (${results.length} checks)\n`);
process.exit(failed ? 1 : 0);
