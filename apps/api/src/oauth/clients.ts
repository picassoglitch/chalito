import type { OAuthClient, Provider } from "./model.js";
import { safeFetch } from "./safe-fetch.js";

/**
 * Client identification (MCP 2026-07-28): Client ID Metadata Documents are preferred (the
 * client_id is an https URL serving the client's metadata); DCR stays for compatibility.
 * Redirects are allowed only to Claude, ChatGPT, or a loopback address (Claude Code, local dev).
 */
const HTTPS_HOSTS = ["claude.ai", "chatgpt.com"];

export const redirectAllowed = (uri: string): boolean => {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return HTTPS_HOSTS.includes(u.hostname);
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return false;
};

/** Loopback redirects may use any port (RFC 8252 §7.3); others must match exactly. */
export const redirectMatches = (registered: string[], uri: string): boolean => {
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return false;
  return registered.some((r) => {
    try {
      const x = new URL(r);
      return x.protocol === "http:" && x.hostname === u.hostname && x.pathname === u.pathname;
    } catch {
      return false;
    }
  });
};

/**
 * Claude or ChatGPT only when the provider itself vouches for the client (review R-M3): a CIMD
 * document served from the provider's own https origin, whose every redirect is https on that
 * same host. Nobody else can publish a document there. DCR clients and anything with a
 * loopback redirect are "other": they never get `session:prompt` or an `mcp:claude|chatgpt` origin.
 */
const PROVIDER_HOSTS: [Exclude<Provider, "other">, string][] = [
  ["claude", "claude.ai"],
  ["chatgpt", "chatgpt.com"],
];

export const providerOf = (
  client: Pick<OAuthClient, "clientId" | "redirectUris"> & { kind?: OAuthClient["kind"] },
): Provider => {
  if (client.kind === "dcr") return "other";
  let id: URL;
  try {
    id = new URL(client.clientId);
  } catch {
    return "other";
  }
  if (id.protocol !== "https:" || id.port || id.username || id.password) return "other";
  for (const [provider, host] of PROVIDER_HOSTS) {
    if (id.hostname !== host) continue;
    const redirectsOk =
      client.redirectUris.length > 0 &&
      client.redirectUris.every((r) => {
        try {
          const u = new URL(r);
          return u.protocol === "https:" && u.hostname === host && !u.port;
        } catch {
          return false;
        }
      });
    return redirectsOk ? provider : "other";
  }
  return "other";
};

export class ClientError extends Error {}

const validate = (m: Record<string, unknown>, kind: "cimd" | "dcr", clientId: string): OAuthClient => {
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string"))
    throw new ClientError("redirect_uris is required");
  if (!uris.every(redirectAllowed))
    throw new ClientError("redirect_uris must be on claude.ai, chatgpt.com or loopback");
  const auth = m.token_endpoint_auth_method ?? "none";
  if (auth !== "none") throw new ClientError("only public clients (token_endpoint_auth_method none)");
  const grants = (m.grant_types ?? ["authorization_code"]) as unknown;
  if (!Array.isArray(grants) || !grants.includes("authorization_code"))
    throw new ClientError("grant_types must include authorization_code");
  const name =
    typeof m.client_name === "string" && m.client_name.trim()
      ? m.client_name.trim().slice(0, 120)
      : new URL(uris[0] as string).hostname;
  return {
    clientId,
    kind,
    clientName: name,
    redirectUris: uris as string[],
    metadata: m,
    fetchedAt: kind === "cimd" ? Date.now() : null,
  };
};

/**
 * Fetches and validates a CIMD document: https, small JSON, `client_id` equal to its own URL.
 * The default fetcher refuses internal addresses at connect time (safe-fetch.ts, review R-M4);
 * failures are reported generically so the endpoint can't be used to probe a network.
 */
export const fetchCimd = async (clientId: string, fetcher: typeof fetch = safeFetch): Promise<OAuthClient> => {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientError("client_id must be a URL");
  }
  if (url.protocol !== "https:" || url.hash || url.username || url.password)
    throw new ClientError("client_id must be an https URL");
  let text: string;
  try {
    const res = await fetcher(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error("status");
    text = await readCapped(res, 64 * 1024);
  } catch {
    throw new ClientError("client metadata could not be fetched");
  }
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ClientError("client metadata could not be fetched");
  }
  if (m.client_id !== clientId) throw new ClientError("client metadata client_id must equal its URL");
  return validate(m, "cimd", clientId);
};

/** Reads at most `max` bytes of a body, failing beyond it (never buffers an unbounded response). */
const readCapped = async (res: Response, max: number): Promise<string> => {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const registerDcr = (m: Record<string, unknown>, clientId: string): OAuthClient => validate(m, "dcr", clientId);
