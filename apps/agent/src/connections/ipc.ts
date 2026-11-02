import { z } from "zod";
import { IpcError, type IpcHandlers } from "../ipc-server.js";
import type { SecretStore } from "../secrets.js";
import { catalogEntry, VerifiedConnectors, type InputSpec } from "./catalog.js";
import {
  getRegistryServer,
  RegistryError,
  searchRegistry,
  type RegistryOptions,
  type RegistryResult,
} from "./registry.js";
import { probeRemoteAuth } from "./net-guard.js";
import { ConnectorStore, ConnectorStoreError, customRemote, customStdio } from "./store.js";
import type { ConnectorEntry } from "./types.js";

export interface ConnectionsSearchFeature {
  verified: VerifiedConnectors;
  store: ConnectorStore;
  registry: RegistryOptions;
  /** Where a custom command is looked up (tests pass their own PATH). */
  env: NodeJS.ProcessEnv;
  /** Audit rows in the ADR 0023 `connector.*` category (ids and sources only). */
  audit: (type: string, meta: Record<string, unknown>) => void;
}

export const connectionsSearchFeature = (d: {
  dir: string;
  secrets: SecretStore;
  audit: (type: string, meta: Record<string, unknown>) => void;
  registry?: RegistryOptions;
  verified?: VerifiedConnectors;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): ConnectionsSearchFeature => ({
  verified: d.verified ?? new VerifiedConnectors(),
  store: new ConnectorStore({ dir: d.dir, secrets: d.secrets, ...(d.now ? { now: d.now } : {}) }),
  registry: d.registry ?? {},
  env: d.env ?? process.env,
  audit: d.audit,
});

const Name = z.string().min(1).max(80);
export const ConnectorRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("verified"), id: z.string().max(64) }).strict(),
  z
    .object({ kind: z.literal("registry"), name: z.string().min(1).max(200), version: z.string().min(1).max(100) })
    .strict(),
  z.object({ kind: z.literal("url"), name: Name, url: z.string().min(1).max(2048), token: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("command"),
      name: Name,
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(64),
      env: z.array(z.string().max(128)).max(16),
    })
    .strict(),
]);
export type ConnectorRef = z.infer<typeof ConnectorRef>;

const Search = z.object({ q: z.string().max(200), cursor: z.string().max(1000).optional() }).strict();
const ForRef = z.object({ ref: ConnectorRef }).strict();
const Install = z
  .object({
    ref: ConnectorRef,
    values: z.record(z.string().max(128), z.string().max(8192)),
    confirmed: z.boolean(),
    warningAccepted: z.boolean(),
  })
  .strict();
const ForId = z.object({ id: z.string().min(1).max(64) }).strict();

const parse = <T>(schema: z.ZodType<T>, params: unknown): T => {
  const r = schema.safeParse(params);
  if (!r.success) throw new IpcError("bad_params");
  return r.data;
};

const asIpc = (e: unknown): never => {
  if (e instanceof ConnectorStoreError || e instanceof RegistryError) throw new IpcError(e.code);
  throw e;
};

interface Resolved {
  entry: ConnectorEntry;
  inputs: InputSpec[];
}

/** Turns what the panel picked into a connector. Verified and registry entries come from their source, never the panel. */
const resolve = async (f: ConnectionsSearchFeature, ref: ConnectorRef): Promise<Resolved> => {
  switch (ref.kind) {
    case "verified": {
      const c = f.verified.get(ref.id);
      if (!c) throw new IpcError("unknown_connector");
      return { entry: catalogEntry(c), inputs: c.inputs };
    }
    case "registry": {
      const r = await getRegistryServer(ref, f.registry);
      return { entry: r.entry, inputs: r.inputs };
    }
    case "url":
      return customRemote(ref);
    case "command":
      return customStdio(ref, f.env);
  }
};

/** A remote community server with no declared auth may still want OAuth: ask it before installing. */
const heldByServer = async (f: ConnectionsSearchFeature, r: Resolved): Promise<"oauth" | null> => {
  if (r.entry.held) return r.entry.held;
  if (r.entry.source === "verified" || r.entry.transport !== "remote" || r.entry.auth !== "none") return null;
  const url = "url" in r.entry.server ? r.entry.server.url : undefined;
  if (!url) return null;
  // Registry URLs are untrusted (public hosts only, checked again at connect); a typed URL is the person's own.
  const probe = await probeRemoteAuth(url, {
    publicOnly: r.entry.source !== "custom" && f.registry.localRemotesForTests !== true,
    ...(f.registry.timeoutMs ? { timeoutMs: f.registry.timeoutMs } : {}),
  });
  if (probe === "unreachable") throw new IpcError("unreachable");
  return probe === "oauth" ? "oauth" : null;
};

const normUrl = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return u;
  }
};
const sameServer = (a: ConnectorEntry, url: string | undefined) =>
  !!url && "url" in a.server && !!a.server.url && normUrl(a.server.url) === normUrl(url);

/** The panel's Conexiones search and install calls (desktop panel/connections/search-ipc.ts). */
export const connectionSearchHandlers = (f: ConnectionsSearchFeature | null | undefined): IpcHandlers => {
  const of = (): ConnectionsSearchFeature => {
    if (!f) throw new IpcError("unavailable");
    return f;
  };
  return {
    connectionsSearch: async (params) => {
      const s = of();
      const { q, cursor } = parse(Search, params);
      let installed: Set<string>;
      try {
        installed = new Set(s.store.list().map((c) => c.id));
      } catch (e) {
        return asIpc(e);
      }
      const verified = cursor
        ? []
        : s.verified.search(q).map((c) => ({
            ref: { kind: "verified" as const, id: c.id },
            entry: catalogEntry(c),
            inputs: c.inputs,
            installed: installed.has(c.id),
          }));
      const verifiedUrls = s.verified.list().map((c) => ("url" in c.server ? c.server.url : undefined));
      let page: { results: RegistryResult[]; nextCursor: string | null; skipped: number } = {
        results: [],
        nextCursor: null,
        skipped: 0,
      };
      let error: string | null = null;
      try {
        page = await searchRegistry(q, cursor, s.registry);
      } catch (e) {
        // Offline still shows the verified ones; the panel says the registry didn't answer.
        if (!(e instanceof RegistryError)) throw e;
        error = e.code;
      }
      const community = page.results
        // The vendor's own server is already offered as Verificado.
        .filter((r) => !verifiedUrls.some((u) => sameServer(r.entry, u)))
        .map((r) => ({
          ref: { kind: "registry" as const, ...r.ref },
          entry: r.entry,
          inputs: r.inputs,
          repository: r.repository,
          installed: installed.has(r.entry.id),
        }));
      return { verified, community, nextCursor: page.nextCursor, skipped: page.skipped, error };
    },

    connectionsInstalled: async () => {
      const s = of();
      try {
        return { installed: s.store.list().map((c) => ({ ...c, slots: s.store.slots(c.id).map((x) => x.name) })) };
      } catch (e) {
        return asIpc(e);
      }
    },

    /** Before the confirmation dialog: what to ask for, and whether it's on hold (OAuth). */
    connectionsCheck: async (params) => {
      const s = of();
      const { ref } = parse(ForRef, params);
      try {
        const r = await resolve(s, ref);
        return { entry: r.entry, inputs: r.inputs, held: await heldByServer(s, r) };
      } catch (e) {
        return asIpc(e);
      }
    },

    connectionsInstall: async (params) => {
      const s = of();
      const p = parse(Install, params);
      try {
        const r = await resolve(s, p.ref);
        if ((await heldByServer(s, r)) === "oauth") throw new IpcError("held_oauth");
        const installed = await s.store.install({
          entry: r.entry,
          inputs: r.inputs,
          values: p.values,
          confirmed: p.confirmed,
          warningAccepted: p.warningAccepted,
        });
        s.audit("connector.installed", {
          id: installed.id,
          source: installed.source,
          transport: installed.transport,
          via: "panel",
        });
        return { installed };
      } catch (e) {
        return asIpc(e);
      }
    },

    connectionsUninstall: async (params) => {
      const s = of();
      const { id } = parse(ForId, params);
      try {
        await s.store.uninstall(id);
        s.audit("connector.uninstalled", { id, via: "panel" });
        return { ok: true };
      } catch (e) {
        return asIpc(e);
      }
    },
  };
};
