import { readConfigFile } from "@chalito/config";
import { fromB64url, signDetached, verifyDetached } from "@chalito/crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CATALOG_KEYS } from "../apps/catalog-keys.js";
import type { ConnectorEntry } from "./types.js";

// ADR 0023 §1: connectors.yaml is compiled in like recipes/catalog.json; a served update needs a compiled-in
// catalog key (apps/catalog-keys.ts), never the dev key.

export const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Header or environment variable names: what a secret is delivered as. */
export const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;

/** One value the person types at install (a token, a project ref). Every value goes to the keychain. */
export const InputSpec = z
  .object({
    name: z.string().regex(INPUT_NAME),
    as: z.enum(["env", "header"]),
    secret: z.boolean(),
    required: z.boolean(),
    /** Put before what the person types (`Bearer `). */
    prefix: z
      .string()
      .regex(/^[\x20-\x7e]{0,64}$/)
      .optional(),
    description: z.string().max(300).optional(),
  })
  .strict();
export type InputSpec = z.infer<typeof InputSpec>;

const RemoteServer = z.object({ url: z.url().max(2048).optional() }).strict();
const StdioServer = z
  .object({
    package: z.string().min(1).max(214),
    version: z.string().min(1).max(64),
    integrity: z.string().max(200).optional(),
    command: z.string().min(1).max(200),
    args: z.array(z.string().max(512)).max(32),
  })
  .strict();

export const CatalogConnector = z
  .object({
    id: z.string().regex(CONNECTOR_ID),
    name: z.string().min(1).max(80),
    description: z.string().max(300),
    transport: z.enum(["remote", "stdio"]),
    server: z.union([StdioServer, RemoteServer]),
    auth: z.enum(["none", "token", "oauth"]),
    held: z.literal("oauth").optional(),
    inputs: z.array(InputSpec).max(16),
    tools: z
      .object({ read: z.array(z.string().max(128)).default([]), write: z.array(z.string().max(128)).default([]) })
      .strict()
      .optional(),
    risk: z.enum(["LOW", "MED", "HIGH"]),
    verified: z
      .object({
        checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        version: z.string().min(1),
        sources: z.array(z.string().min(1)).min(1),
        unverified: z.array(z.string().min(1)).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const remote = "url" in c.server || !("command" in c.server);
    if ((c.transport === "remote") !== remote)
      ctx.addIssue({ code: "custom", message: "server does not match transport" });
    // An installable remote needs its URL; only held entries may lack one.
    if (c.transport === "remote" && !c.held && !("url" in c.server && c.server.url))
      ctx.addIssue({ code: "custom", message: "remote server needs a url" });
    if (c.auth === "oauth" && c.held !== "oauth") ctx.addIssue({ code: "custom", message: "oauth entries are held" });
  });
export type CatalogConnector = z.infer<typeof CatalogConnector>;

export const ConnectorCatalog = z
  .object({ v: z.literal(1), issuedAt: z.number().int().positive(), connectors: z.array(CatalogConnector).max(200) })
  .strict()
  .superRefine((c, ctx) => {
    const ids = c.connectors.map((x) => x.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate connector id" });
  });
export type ConnectorCatalog = z.infer<typeof ConnectorCatalog>;

export const CONNECTOR_CATALOG_CTX = "chalito.connector-catalog.v1" as const;
export const SignedConnectorCatalog = z
  .object({
    ctx: z.literal(CONNECTOR_CATALOG_CTX),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    body: z.unknown(),
    sig: z.string().min(1).max(200),
  })
  .strict();

/** The catalog shipped with this agent. Throws on a bad file: that's a build bug (the tests guard it). */
export const loadBuiltinConnectors = (text: string = readConfigFile("connectors.yaml")): ConnectorCatalog =>
  ConnectorCatalog.parse(parseYaml(text));

export type ConnectorCatalogVerify =
  | { ok: true; catalog: ConnectorCatalog; keyId: string }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" };

/** Checks a served catalog against the compiled-in keys (tests pass the dev key explicitly). */
export const verifyConnectorCatalog = async (
  raw: unknown,
  keys: Readonly<Record<string, string>> = CATALOG_KEYS,
): Promise<ConnectorCatalogVerify> => {
  const env = SignedConnectorCatalog.safeParse(raw);
  if (!env.success) return { ok: false, reason: "malformed" };
  const pub = Object.hasOwn(keys, env.data.keyId) ? keys[env.data.keyId] : undefined;
  if (!pub) return { ok: false, reason: "unknown_key" };
  // Verify the body exactly as served, then parse it.
  if (!(await verifyDetached(CONNECTOR_CATALOG_CTX, env.data.body, env.data.sig, await fromB64url(pub))))
    return { ok: false, reason: "bad_signature" };
  const body = ConnectorCatalog.safeParse(env.data.body);
  return body.success ? { ok: true, catalog: body.data, keyId: env.data.keyId } : { ok: false, reason: "malformed" };
};

export const signConnectorCatalog = async (catalog: ConnectorCatalog, key: { keyId: string; secretKey: string }) => ({
  ctx: CONNECTOR_CATALOG_CTX,
  keyId: key.keyId,
  body: catalog,
  sig: await signDetached(CONNECTOR_CATALOG_CTX, catalog, await fromB64url(key.secretKey)),
});

/** The shared entry for a catalog connector (what the store and the proxy keep). */
export const catalogEntry = (c: CatalogConnector): ConnectorEntry => ({
  id: c.id,
  name: c.name,
  description: c.description,
  source: "verified",
  transport: c.transport,
  server: c.server,
  auth: c.auth,
  ...(c.held ? { held: c.held } : {}),
});

/** Verified connectors in use: the built-in ones, or a newer verified served catalog. */
export class VerifiedConnectors {
  #catalog: ConnectorCatalog;
  constructor(
    builtin: ConnectorCatalog = loadBuiltinConnectors(),
    private readonly keys: Readonly<Record<string, string>> = CATALOG_KEYS,
  ) {
    this.#catalog = builtin;
  }
  get issuedAt() {
    return this.#catalog.issuedAt;
  }
  list(): CatalogConnector[] {
    return this.#catalog.connectors;
  }
  get(id: string): CatalogConnector | undefined {
    return this.#catalog.connectors.find((c) => c.id === id);
  }
  async offer(raw: unknown): Promise<ConnectorCatalogVerify & { applied?: boolean }> {
    const v = await verifyConnectorCatalog(raw, this.keys);
    if (!v.ok) return v;
    if (v.catalog.issuedAt <= this.#catalog.issuedAt) return { ...v, applied: false };
    this.#catalog = v.catalog;
    return { ...v, applied: true };
  }
  /** Case-insensitive match on id, name and description. */
  search(q: string): CatalogConnector[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return this.list();
    return this.list().filter((c) => `${c.id} ${c.name} ${c.description}`.toLowerCase().includes(needle));
  }
}
