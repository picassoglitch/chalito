import type { OAuthClient, Provider } from "./model.js";

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

export const providerOf = (client: Pick<OAuthClient, "clientId" | "redirectUris">): Provider => {
  const hosts = [client.clientId, ...client.redirectUris].flatMap((u) => {
    try {
      return [new URL(u).hostname];
    } catch {
      return [];
    }
  });
  if (hosts.some((h) => h === "claude.ai" || h.endsWith(".claude.ai"))) return "claude";
  if (hosts.some((h) => h === "chatgpt.com" || h.endsWith(".chatgpt.com"))) return "chatgpt";
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

/** Fetches and validates a CIMD document: https, small JSON, `client_id` equal to its own URL. */
export const fetchCimd = async (clientId: string, fetcher: typeof fetch = fetch): Promise<OAuthClient> => {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new ClientError("client_id must be a URL");
  }
  if (url.protocol !== "https:" || url.hash || url.username || url.password)
    throw new ClientError("client_id must be an https URL");
  const res = await fetcher(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new ClientError(`client metadata: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 64 * 1024) throw new ClientError("client metadata too large");
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ClientError("client metadata is not JSON");
  }
  if (m.client_id !== clientId) throw new ClientError("client metadata client_id must equal its URL");
  return validate(m, "cimd", clientId);
};

export const registerDcr = (m: Record<string, unknown>, clientId: string): OAuthClient => validate(m, "dcr", clientId);
