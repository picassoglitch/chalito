import { z } from "zod";
import { ENV_NAME, INPUT_NAME, type InputSpec } from "./catalog.js";
import { isPublicHostname } from "./net-guard.js";
import type { ConnectorEntry } from "./types.js";

// Official MCP Registry, API v0.1 (the frozen stable one): https://registry.modelcontextprotocol.io/openapi.yaml
export const REGISTRY_BASE = "https://registry.modelcontextprotocol.io";
export const REGISTRY_TIMEOUT_MS = 10_000;
export const REGISTRY_MAX_BYTES = 2 * 1024 * 1024;
export const REGISTRY_PAGE = 30;

/** A registry server, mapped. `ref` re-resolves it at install, so the panel never hands the agent a server. */
export interface RegistryResult {
  ref: { name: string; version: string };
  entry: ConnectorEntry;
  inputs: InputSpec[];
  repository: string | null;
}

export interface RegistryPage {
  results: RegistryResult[];
  nextCursor: string | null;
  /** Servers we can't install (unsupported package type, templated URL, unfilled required args). */
  skipped: number;
}

export type RegistryErrorCode = "query_too_short" | "registry_unreachable" | "registry_bad_response" | "not_found";
export class RegistryError extends Error {
  constructor(readonly code: RegistryErrorCode) {
    super(code);
    this.name = "RegistryError";
  }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// Everything below is untrusted: loose shapes, every string capped and re-checked before use.
const Str = (max: number) => z.string().max(max);
const KeyValue = z.object({
  name: Str(200),
  description: Str(2000).optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  value: Str(2000).optional(),
  default: Str(2000).optional(),
});
const Argument = z.object({
  type: z.enum(["positional", "named"]),
  name: Str(200).optional(),
  value: Str(2000).optional(),
  default: Str(2000).optional(),
  isRequired: z.boolean().optional(),
});
const Package = z.object({
  registryType: Str(40),
  identifier: Str(300),
  version: Str(100).optional(),
  fileSha256: Str(64).optional(),
  transport: z.object({ type: Str(40) }),
  packageArguments: z.array(Argument).max(64).optional(),
  environmentVariables: z.array(KeyValue).max(64).optional(),
});
const Remote = z.object({ type: Str(40), url: Str(2048).optional(), headers: z.array(KeyValue).max(32).optional() });
const ServerJson = z.object({
  name: Str(200),
  title: Str(200).optional(),
  description: Str(10_000).optional(),
  version: Str(100),
  repository: z.object({ url: Str(500).optional() }).optional(),
  packages: z.array(Package).max(32).optional(),
  remotes: z.array(Remote).max(32).optional(),
});
const Official = z.object({ status: Str(40).optional() }).optional();
const ServerResponse = z.object({
  server: ServerJson,
  _meta: z.object({ "io.modelcontextprotocol.registry/official": Official }).optional(),
});
const ListResponse = z.object({
  servers: z.array(z.unknown()).max(200),
  metadata: z.object({ nextCursor: Str(1000).optional() }).optional(),
});

// Strip control and bidi characters (they could disguise a name) and cap the length.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
export const clean = (s: string | undefined, max: number): string => {
  const t = (s ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Registry names (`io.github.owner/server`) as a connector id that is safe in tool names and keychain keys. */
export const registryId = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^custom-/, "reg-custom-") // `custom-` ids belong to "Agregar la tuya"
    .slice(0, 64)
    .replace(/-+$/, "") || "server";

// The registry entry's own version: only an id for re-reading it, never what runs.
const SERVER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
// What runs must be pinned: tags like latest/next or ranges would change under us.
export const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/; // no +build: npm drops it
export const PYPI_VERSION = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
// eslint-disable-next-line no-control-regex
const SAFE_ARG = /^[^\u0000-\u001f\u007f]{1,512}$/;

// Registry data: HTTPS to a public DNS name only (SSRF). `local` = a URL the person typed: also HTTP to
// this computer. Never credentials in the URL.
export const safeRemoteUrl = (raw: string, o: { local: boolean } = { local: false }): string | null => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || raw.includes("{")) return null;
  if (u.protocol === "https:" && (o.local || isPublicHostname(u.hostname))) return u.toString();
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return o.local && u.protocol === "http:" && loopback ? u.toString() : null;
};

// Names that would let a listed server steer the runtime (another package index, preloaded code) or the HTTP framing.
const RISKY_ENV =
  /^(?:(?:PATH|PATHEXT|HOME|ENV|BASH_ENV|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|(?:HTTPS?|ALL|NO)_PROXY)$|NODE_|LD_|DYLD_|npm_config_|NPM_|YARN_|PNPM_|UV_|PIP_|PYTHON|COREPACK_|BUN_|GIT_|SSL_)/i;
const RISKY_HEADER = /^(host|content-length|transfer-encoding|connection|cookie|upgrade|te|trailer|proxy-.*)$/i;

/** A `{var}` template the person fills: only `prefix{var}` is supported (e.g. `Bearer {token}`). */
const templatePrefix = (value: string): string | null | undefined => {
  if (!value.includes("{")) return undefined;
  // Printable ASCII only: a CR/LF in the prefix would inject a header or env line.
  const m = /^([\x20-\x7e]{0,64})\{[\w.-]{1,64}\}$/.exec(value);
  if (m && /[{}]/.test(m[1]!)) return null;
  return m ? m[1]! : null;
};

const toInput = (kv: z.infer<typeof KeyValue>, as: InputSpec["as"]): InputSpec | null => {
  if (!INPUT_NAME.test(kv.name)) return null;
  if (as === "env" ? RISKY_ENV.test(kv.name) || !ENV_NAME.test(kv.name) : RISKY_HEADER.test(kv.name)) return null;
  // The proxy (PR C) only sends one header, `Authorization: Bearer <token>`; anything else we can't deliver.
  if (as === "header" && kv.name.toLowerCase() !== "authorization") return null;
  const prefix = kv.value === undefined ? undefined : templatePrefix(kv.value);
  if (prefix === null) return null;
  if (as === "header" && prefix !== undefined && prefix !== "Bearer ") return null;
  // A fixed value (no template) isn't something the person types; we don't carry fixed values.
  if (kv.value !== undefined && prefix === undefined) return null;
  const description = clean(kv.description, 300);
  return {
    name: kv.name,
    as,
    secret: kv.isSecret === true || kv.name.toLowerCase() === "authorization",
    required: kv.isRequired === true && kv.default === undefined,
    ...(prefix ? { prefix } : {}),
    ...(description ? { description } : {}),
  };
};

const argList = (args: z.infer<typeof Argument>[] | undefined): string[] | null => {
  const out: string[] = [];
  for (const a of args ?? []) {
    const value = a.value ?? a.default;
    if (value === undefined) {
      if (a.isRequired) return null; // We can't ask for argument values yet: not installable.
      continue;
    }
    if (!SAFE_ARG.test(value) || value.includes("{")) return null;
    if (a.type === "named") {
      if (!a.name || !/^-{1,2}[A-Za-z0-9][\w-]{0,63}$/.test(a.name)) return null;
      out.push(a.name);
    }
    out.push(value);
  }
  return out;
};

/** One registry server → a community connector, or null when Chalito can't run it safely. */
export const mapServer = (raw: unknown, o: { localForTests?: boolean } = {}): RegistryResult | null => {
  const parsed = ServerResponse.safeParse(raw);
  if (!parsed.success) return null;
  const { server, _meta } = parsed.data;
  const status = _meta?.["io.modelcontextprotocol.registry/official"]?.status;
  if (status !== undefined && status !== "active") return null;
  if (!SERVER_VERSION.test(server.version)) return null;
  const base = {
    id: registryId(server.name),
    name: clean(server.title || server.name.split("/").pop() || server.name, 80),
    description: clean(server.description, 300),
    source: "community" as const,
  };
  const repo = server.repository?.url ? safeRemoteUrl(server.repository.url) : null;
  const ref = { name: server.name, version: server.version };

  // Prefer a vendor-run streamable HTTP server (ADR 0023 §1), then a pinned npm/PyPI package.
  for (const r of server.remotes ?? []) {
    if (r.type !== "streamable-http" || !r.url) continue;
    const url = safeRemoteUrl(r.url, { local: o.localForTests === true });
    if (!url) continue;
    const inputs = (r.headers ?? []).map((h) => toInput(h, "header"));
    if (inputs.some((i) => i === null)) continue;
    const ok = inputs as InputSpec[];
    return {
      ref,
      repository: repo,
      inputs: ok,
      entry: { ...base, transport: "remote", server: { url }, auth: ok.some((i) => i.secret) ? "token" : "none" },
    };
  }
  for (const p of server.packages ?? []) {
    if (p.transport.type !== "stdio" || !p.version) continue;
    let command: string;
    let pkgArg: string;
    if (p.registryType === "npm" && NPM_NAME.test(p.identifier) && NPM_VERSION.test(p.version)) {
      command = "npx";
      pkgArg = `${p.identifier}@${p.version}`;
    } else if (p.registryType === "pypi" && PYPI_NAME.test(p.identifier) && PYPI_VERSION.test(p.version)) {
      command = "uvx";
      pkgArg = `${p.identifier}==${p.version}`;
    } else continue;
    const args = argList(p.packageArguments);
    if (!args) continue;
    const inputs = (p.environmentVariables ?? []).map((e) => toInput(e, "env"));
    if (inputs.some((i) => i === null)) continue;
    const ok = inputs as InputSpec[];
    // npm is pinned from npmjs at install (ipc.ts); the registry's own hash is only used for PyPI.
    const integrity =
      command === "uvx" && p.fileSha256 && /^[a-f0-9]{64}$/.test(p.fileSha256) ? `sha256-${p.fileSha256}` : undefined;
    return {
      ref,
      repository: repo,
      inputs: ok,
      entry: {
        ...base,
        transport: "stdio",
        server: {
          package: p.identifier,
          version: p.version,
          ...(integrity ? { integrity } : {}),
          command,
          args: command === "npx" ? ["-y", pkgArg, ...args] : [pkgArg, ...args],
        },
        auth: ok.some((i) => i.secret) ? "token" : "none",
      },
    };
  }
  return null;
};

/** GET with a timeout and a size cap; the body is parsed as JSON only once it fits. */
const getJson = async (fetchFn: Fetch, url: string, timeoutMs: number): Promise<unknown> => {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RegistryError("registry_unreachable");
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new RegistryError(res.status === 404 ? "not_found" : "registry_bad_response");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REGISTRY_MAX_BYTES) {
        await reader.cancel();
        throw new RegistryError("registry_bad_response");
      }
      chunks.push(value);
    }
  } catch (e) {
    throw e instanceof RegistryError ? e : new RegistryError("registry_unreachable");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RegistryError("registry_bad_response");
  }
};

export interface RegistryOptions {
  fetch?: Fetch;
  base?: string;
  timeoutMs?: number;
  limit?: number;
  /** Tests only (never reachable from the panel): registry remotes on this computer. */
  localRemotesForTests?: boolean;
  /** npm registry (tests point it at a local server). */
  npmBase?: string;
}

export const NPM_BASE = "https://registry.npmjs.org";
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** ADR 0023 §1: the npm tarball hash at install, so a re-published or swapped package can be refused later. */
export const npmIntegrity = async (pkg: string, version: string, o: RegistryOptions = {}): Promise<string> => {
  const url = `${o.npmBase ?? NPM_BASE}/${pkg.replace("/", "%2F")}/${encodeURIComponent(version)}`;
  const raw = (await getJson(o.fetch ?? fetch, url, o.timeoutMs ?? REGISTRY_TIMEOUT_MS)) as {
    version?: unknown;
    dist?: { integrity?: unknown };
  };
  const integrity = raw?.dist?.integrity;
  if (raw?.version !== version || typeof integrity !== "string" || !SRI.test(integrity))
    throw new RegistryError("registry_bad_response");
  return integrity;
};

/** Searches the registry by server name (latest versions only). Empty `q` lists everything. */
export const searchRegistry = async (q: string, cursor?: string, o: RegistryOptions = {}): Promise<RegistryPage> => {
  const query = q.trim();
  // The registry rejects 1–2 character searches; say so instead of a 400.
  if (query.length > 0 && query.length < 3) throw new RegistryError("query_too_short");
  const url = new URL("/v0.1/servers", o.base ?? REGISTRY_BASE);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(o.limit ?? REGISTRY_PAGE));
  if (query) url.searchParams.set("search", query.slice(0, 100));
  if (cursor) url.searchParams.set("cursor", cursor.slice(0, 1000));
  const body = ListResponse.safeParse(
    await getJson(o.fetch ?? fetch, url.toString(), o.timeoutMs ?? REGISTRY_TIMEOUT_MS),
  );
  if (!body.success) throw new RegistryError("registry_bad_response");
  const results: RegistryResult[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const s of body.data.servers) {
    const r = mapServer(s, { localForTests: o.localRemotesForTests === true });
    // Two names can slug to one id; keep the first so ids stay unique on a page.
    if (!r || seen.has(r.entry.id)) {
      skipped++;
      continue;
    }
    seen.add(r.entry.id);
    results.push(r);
  }
  return { results, nextCursor: body.data.metadata?.nextCursor || null, skipped };
};

/** One exact server version, re-read from the registry at install time. */
export const getRegistryServer = async (
  ref: { name: string; version: string },
  o: RegistryOptions = {},
): Promise<RegistryResult> => {
  const path = `/v0.1/servers/${encodeURIComponent(ref.name)}/versions/${encodeURIComponent(ref.version)}`;
  const raw = await getJson(
    o.fetch ?? fetch,
    new URL(path, o.base ?? REGISTRY_BASE).toString(),
    o.timeoutMs ?? REGISTRY_TIMEOUT_MS,
  );
  const r = mapServer(raw, { localForTests: o.localRemotesForTests === true });
  if (!r || r.ref.name !== ref.name || r.ref.version !== ref.version) throw new RegistryError("not_found");
  return r;
};
