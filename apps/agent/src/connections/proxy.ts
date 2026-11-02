import { randomBytes } from "node:crypto";
import type { lookup as dnsLookup } from "node:dns";
import type { RiskTier } from "@chalito/protocol";
import type { SecretStore } from "../secrets.js";
import { clearInstalled, readInstalled } from "./installed.js";
import {
  auditHash,
  byteSize,
  capText,
  namespacedName,
  quoteConnectorData,
  RESULT_CAP_BYTES,
  runnable,
  slugFor,
  toolRisk,
  type UpstreamTool,
} from "./risk.js";
import { ConnectorError, RpcError, type FetchLike } from "./transport.js";
import type { ConnectorStamp, InstalledConnector } from "./types.js";
import { fingerprint, secretName, Upstream } from "./upstream.js";

const CALL_TIMEOUT_MS = 120_000;
const LIST_BUDGET_MS = 20_000;
const MAX_DESCRIPTION = 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_ERROR_TEXT = 2048;

export interface ProxyTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: true };
}

export interface ProxyResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Who is calling: the agent app that launched `chalito-agent connections mcp`, and its connection. */
export interface ProxyClient {
  key: string;
  app?: string;
}

export interface GateCall {
  stamp: ConnectorStamp;
  name: string;
  args: Record<string, unknown>;
  client: ProxyClient;
  signal: AbortSignal;
}
export type ConnectorGate = (call: GateCall) => Promise<{ allow: boolean; reason: string }>;

export interface ProxyDeps {
  /** ~/.chalito */
  dir: string;
  secrets: SecretStore;
  gate: ConnectorGate;
  /** Audit sink, category `connector.*`: hashes, sizes and ids only. */
  audit: (type: string, meta: Record<string, unknown>) => void;
  /** The signed verified catalog's `tools.read` for a connector id: the only way a tool gets the read tier. */
  readTools?: (connectorId: string) => readonly string[];
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  lookup?: typeof dnsLookup;
  localRemotesForTests?: boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  resultCap?: number;
  callTimeoutMs?: number;
  version?: string;
}

const LABEL: Record<InstalledConnector["source"], string> = {
  verified: "Verificado",
  community: "Comunidad",
  custom: "Comunidad",
};

const clean = (s: unknown, max: number): string =>
  typeof s === "string" ? s.replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, max) : "";

const unrefTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
};

/** One upstream result as plain text: non-text parts are named, never inlined. */
const resultText = (result: unknown): { text: string; isError: boolean } => {
  if (!result || typeof result !== "object") throw new ConnectorError("connector_protocol");
  const r = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  if (!Array.isArray(r.content) && r.structuredContent === undefined) throw new ConnectorError("connector_protocol");
  const parts: string[] = [];
  let dropped = 0;
  if (Array.isArray(r.content))
    for (const item of r.content as Record<string, unknown>[]) {
      if (!item || typeof item !== "object") {
        dropped++;
        continue;
      }
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item.type === "resource" && item.resource && typeof item.resource === "object") {
        const res = item.resource as { text?: unknown; uri?: unknown; mimeType?: unknown };
        parts.push(typeof res.text === "string" ? res.text : `[resource ${clean(res.uri, 512)} omitted]`);
      } else if (item.type === "resource_link") parts.push(`[link ${clean(item.uri, 512)}]`);
      else if (item.type === "image" || item.type === "audio")
        parts.push(
          `[${item.type} ${clean(item.mimeType, 64)} omitted, ${typeof item.data === "string" ? item.data.length : 0} base64 chars]`,
        );
      else dropped++;
    }
  if (dropped) parts.push(`[${dropped} unsupported parts omitted]`);
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent) ?? "");
  return { text: parts.join("\n"), isError: r.isError === true };
};

/** ADR 0023 §4: all installed connectors behind one MCP surface; each call stamped, gated, capped, quoted, audited. */
export class ConnectionsProxy {
  readonly #d: ProxyDeps;
  readonly #key = randomBytes(32);
  #upstreams = new Map<string, Upstream>();
  #names = new Map<string, { connectorId: string; fp: string; stamp: ConnectorStamp; slug: string }>();
  #closed = false;
  // Set for the whole of revoke-all: nothing may start or be listed while secrets are being deleted.
  #revoking = 0;

  constructor(d: ProxyDeps) {
    this.#d = d;
  }

  get #now() {
    return this.#d.now ?? Date.now;
  }

  /** Re-reads the installed list; servers that were removed, changed or held stop now. */
  #sync(): InstalledConnector[] {
    if (this.#revoking) return [];
    const installed = readInstalled(this.#d.dir, (type, meta) => this.#d.audit(type, meta)).filter(runnable);
    const live = new Map(installed.map((c) => [c.id, fingerprint(c)]));
    for (const [id, up] of this.#upstreams)
      if (live.get(id) !== up.fp) {
        this.#upstreams.delete(id);
        void up.stop();
      }
    return installed;
  }

  #upstream(c: InstalledConnector): Upstream {
    if (this.#closed || this.#revoking) throw new ConnectorError("connector_stopped");
    let up = this.#upstreams.get(c.id);
    if (!up) {
      up = new Upstream(c, {
        secrets: this.#d.secrets,
        env: this.#d.env ?? process.env,
        ...(this.#d.fetch ? { fetch: this.#d.fetch } : {}),
        ...(this.#d.lookup ? { lookup: this.#d.lookup } : {}),
        ...(this.#d.localRemotesForTests ? { localRemotesForTests: true } : {}),
        ...(this.#d.platform ? { platform: this.#d.platform } : {}),
        now: this.#now,
        setTimer: this.#d.setTimer ?? unrefTimer,
        event: (type, meta) => this.#d.audit(type, meta),
        ...(this.#d.version ? { version: this.#d.version } : {}),
      });
      this.#upstreams.set(c.id, up);
    }
    return up;
  }

  /** Every runnable connector's tools, namespaced `<connector>__<tool>`; a server that won't start is left out. */
  async listTools(): Promise<ProxyTool[]> {
    if (this.#closed) return [];
    const installed = this.#sync();
    const slugs = new Map<string, string>();
    const used = new Set<string>();
    for (const c of installed) {
      let slug = slugFor(c.id);
      for (let i = 2; used.has(slug); i++) slug = `${slugFor(c.id).slice(0, 21)}-${i}`;
      used.add(slug);
      slugs.set(c.id, slug);
    }
    const budget = new Promise<"timeout">((r) => unrefTimer(() => r("timeout"), LIST_BUDGET_MS));
    const lists = await Promise.all(
      installed.map(async (c) => {
        let up: Upstream;
        try {
          up = this.#upstream(c);
        } catch {
          return null;
        }
        try {
          const tools = await Promise.race([up.tools(), budget]);
          if (tools === "timeout") throw new ConnectorError("connector_timeout");
          return { c, up, tools };
        } catch (e) {
          this.#d.audit("connector.unavailable", {
            connector: c.id,
            error: e instanceof ConnectorError ? e.code : e instanceof RpcError ? "rpc_error" : "connector_unavailable",
          });
          return { c, up, tools: [] as UpstreamTool[] };
        }
      }),
    );
    const names = new Map<string, { connectorId: string; fp: string; stamp: ConnectorStamp; slug: string }>();
    const out: ProxyTool[] = [];
    for (const listed of lists) {
      if (!listed) continue;
      const { c, up, tools } = listed;
      const slug = slugs.get(c.id)!;
      const readTools = c.source === "verified" ? (this.#d.readTools?.(c.id) ?? []) : [];
      let skipped = 0;
      for (const t of tools) {
        const name = namespacedName(slug, t.name);
        const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" };
        if (!name || names.has(name) || byteSize(schema) > MAX_SCHEMA_BYTES) {
          skipped++;
          continue;
        }
        const { tier, risk } = toolRisk(c, t, readTools);
        names.set(name, {
          connectorId: c.id,
          fp: up.fp,
          slug,
          stamp: { connectorId: c.id, source: c.source, tool: t.name, tier, risk },
        });
        out.push({
          name,
          title: `${clean(c.name, 80)} · ${t.name}`,
          // The label comes first so a server's own text can't pass itself off as verified.
          description: `[${LABEL[c.source]} · ${clean(c.name, 80)}] ${clean(t.description, MAX_DESCRIPTION)}`,
          inputSchema: schema,
          annotations: { readOnlyHint: tier === "read", destructiveHint: risk === "HIGH", openWorldHint: true },
        });
      }
      if (skipped) this.#d.audit("connector.tools_skipped", { connector: c.id, count: skipped });
    }
    this.#names = names;
    return out;
  }

  async callTool(name: string, rawArgs: unknown, client: ProxyClient, signal: AbortSignal): Promise<ProxyResult> {
    const started = this.#now();
    const args = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<
      string,
      unknown
    >;
    const fail = (text: string): ProxyResult => ({ content: [{ type: "text", text }], isError: true });
    if (this.#closed) return fail("Chalito connections are stopped.");
    let entry = this.#names.get(name);
    if (!entry) {
      await this.listTools();
      entry = this.#names.get(name);
    }
    // Checked again at call time: an uninstall or change since the list must win.
    const c = this.#sync().find((x) => x.id === entry?.connectorId);
    if (!entry || !c || fingerprint(c) !== entry.fp)
      return fail(`Unknown tool ${clean(name, 64)}. List the tools again.`);
    const { stamp, slug } = entry;
    const base = {
      connector: c.id,
      tool: stamp.tool,
      source: stamp.source,
      tier: stamp.tier,
      risk: stamp.risk as RiskTier,
      client: client.app ?? "unknown",
      argsHash: auditHash(this.#key, args),
      argsBytes: byteSize(args),
    };
    let decision: { allow: boolean; reason: string };
    try {
      decision = await this.#d.gate({ stamp, name, args, client, signal });
    } catch (e) {
      decision = { allow: false, reason: "gate_error" };
      this.#d.audit("connector.gate_error", { connector: c.id, error: e instanceof Error ? e.name : "unknown" });
    }
    if (!decision.allow || signal.aborted) {
      this.#d.audit("connector.call", {
        ...base,
        decision: "deny",
        reason: decision.allow ? "cancelled" : decision.reason,
        ms: this.#now() - started,
      });
      return fail(`Chalito did not allow ${name} (${clean(decision.allow ? "cancelled" : decision.reason, 40)}).`);
    }
    // The approval may have taken minutes: an uninstall, edit, revoke-all or stop in that time wins.
    if (this.#closed) {
      this.#d.audit("connector.call", { ...base, decision: "deny", reason: "stopped", ms: this.#now() - started });
      return fail("Chalito connections are stopped.");
    }
    const current = this.#closed ? undefined : this.#sync().find((x) => x.id === c.id);
    if (!current || fingerprint(current) !== entry.fp) {
      this.#d.audit("connector.call", { ...base, decision: "deny", reason: "changed", ms: this.#now() - started });
      return fail(`${clean(c.name, 80)} was changed or removed while waiting. List the tools again.`);
    }
    let up: Upstream;
    let raw: unknown;
    let callSecrets: string[] = [];
    try {
      up = this.#upstream(current);
      raw = await up.call(stamp.tool, args, this.#d.callTimeoutMs ?? CALL_TIMEOUT_MS, signal, (v) => (callSecrets = v));
    } catch (e) {
      const code = e instanceof ConnectorError ? e.code : e instanceof RpcError ? "rpc_error" : "connector_unavailable";
      this.#d.audit("connector.call", {
        ...base,
        decision: "allow",
        reason: decision.reason,
        ok: false,
        error: code,
        ms: this.#now() - started,
      });
      // Without the values to scrub, a token connector's error text is dropped rather than risked.
      if (e instanceof RpcError && (callSecrets.length || current.auth !== "token")) {
        let msg = clean(e.rpcMessage, MAX_ERROR_TEXT);
        for (const secret of callSecrets) msg = msg.split(secret).join("[secret]");
        return fail(quoteConnectorData(slug, stamp.tool, LABEL[c.source], { error: msg }));
      }
      // A write that timed out may still have happened on the server.
      if (stamp.tier === "write" && ["connector_timeout", "cancelled", "connector_crashed"].includes(code))
        return fail(
          `${clean(c.name, 80)} did not answer in time (${code}); it may still have run. Check before retrying.`,
        );
      return fail(`The ${clean(c.name, 80)} connection failed (${code}).`);
    }
    try {
      const { text: full, isError } = resultText(raw);
      let text = full;
      for (const secret of callSecrets) text = text.split(secret).join("[secret]");
      const capped = capText(text, this.#d.resultCap ?? RESULT_CAP_BYTES);
      this.#d.audit("connector.call", {
        ...base,
        decision: "allow",
        reason: decision.reason,
        ok: !isError,
        resultHash: auditHash(this.#key, full),
        resultBytes: capped.bytes,
        truncated: capped.truncated,
        ms: this.#now() - started,
      });
      const framed = quoteConnectorData(slug, stamp.tool, LABEL[c.source], capped.text);
      const note = capped.truncated
        ? `\n[Chalito cut this result at ${this.#d.resultCap ?? RESULT_CAP_BYTES} of ${capped.bytes} bytes.]`
        : "";
      return { content: [{ type: "text", text: framed + note }], ...(isError ? { isError: true } : {}) };
    } catch (e) {
      // The server already ran the call: say so rather than "failed", so a write isn't repeated blindly.
      const code = e instanceof ConnectorError ? e.code : "proxy_error";
      this.#d.audit("connector.call", { ...base, decision: "allow", reason: decision.reason, ok: false, error: code });
      return fail(`${clean(c.name, 80)} ran the call but its answer couldn't be read (${code}).`);
    }
  }

  /** Agent stop: every server's process group is killed. */
  async close(): Promise<void> {
    this.#closed = true;
    const all = [...this.#upstreams.values()];
    this.#upstreams.clear();
    this.#names.clear();
    await Promise.all(all.map((u) => u.stop()));
  }

  /** ADR 0020 revoke-all: servers stop, their keychain entries go, and the installed list empties. */
  async revokeAll(by: string): Promise<number> {
    this.#revoking++;
    try {
      let unreadable = false;
      const installed = readInstalled(this.#d.dir, (type, meta) => {
        if (type === "connector.store_unreadable") unreadable = true;
        this.#d.audit(type, meta);
      });
      const targets = new Map<string, InstalledConnector>();
      for (const c of [...installed, ...[...this.#upstreams.values()].map((u) => u.c)]) targets.set(c.id, c);
      // The list goes first so nothing can be started from it while servers stop and secrets go.
      let clearFailed = false;
      if (!unreadable)
        try {
          clearInstalled(this.#d.dir);
        } catch {
          clearFailed = true;
        }
      const stopAll = async () => {
        const all = [...this.#upstreams.values()];
        this.#upstreams.clear();
        this.#names.clear();
        await Promise.all(all.map((u) => u.stop()));
      };
      await stopAll();
      let secretsFailed = 0;
      for (const c of targets.values())
        for (const account of new Set(["token", ...(c.secretEnv ?? [])]))
          await this.#d.secrets.delete(secretName(c.id, account)).catch(() => void secretsFailed++);
      await stopAll();
      this.#d.audit("connector.revoke_all", { count: targets.size, by, secretsFailed, unreadable, clearFailed });
      if (secretsFailed || unreadable || clearFailed) throw new ConnectorError("revoke_incomplete");
      return targets.size;
    } finally {
      this.#revoking--;
    }
  }

  /** For tests and status: which connectors have a live server. */
  running(): { id: string; pid?: number }[] {
    return [...this.#upstreams.values()]
      .filter((u) => u.running)
      .map((u) => ({ id: u.c.id, ...(u.pid !== undefined ? { pid: u.pid } : {}) }));
  }
}
