import type { SecretStore } from "../secrets.js";
import { ConnectorError, HttpTransport, StdioTransport, type FetchLike, type Transport } from "./transport.js";
import type { UpstreamTool } from "./risk.js";
import type { InstalledConnector } from "./types.js";

export const CLIENT_PROTOCOL = "2025-06-18";
export const MAX_RESTARTS = 5;
const INIT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 20;
const MAX_TOOLS = 256;
const HEALTHY_MS = 60_000;
// Only what a server needs to find its runtime; the agent's own API keys never reach it.
const PASS_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "ComSpec",
  "PATHEXT",
];

export const secretName = (connectorId: string, account: string) => `chalito.connector.${connectorId}.${account}`;

/** Restart delay after the n-th crash in a row: 1s, 2s, 4s … at most 30s. */
export const backoffMs = (n: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, n - 1));

/** Same config, same running server; anything else is a different server. */
export const fingerprint = (c: InstalledConnector) =>
  JSON.stringify([c.transport, c.server, c.auth, c.secretEnv ?? [], c.source, c.confirmedWarning]);

export interface UpstreamDeps {
  secrets: SecretStore;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  platform?: NodeJS.Platform;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { clear(): void };
  /** Lifecycle audit (`connector.started`, `.crashed`, …): ids and counts only. */
  event: (type: string, meta: Record<string, unknown>) => void;
  version?: string;
}

/** One installed connector's server: started on first use, restarted with backoff after a crash. */
export class Upstream {
  readonly fp: string;
  #transport: Transport | null = null;
  #starting: Promise<Transport> | null = null;
  #tools: UpstreamTool[] | null = null;
  #failures = 0;
  #retryAt = 0;
  #readyAt = 0;
  #restartTimer: { clear(): void } | null = null;
  #stopped = false;
  /** Secret values, so a result that echoes one can be scrubbed before an agent sees it. */
  secretValues: string[] = [];

  constructor(
    readonly c: InstalledConnector,
    private readonly d: UpstreamDeps,
  ) {
    this.fp = fingerprint(c);
  }

  get running() {
    return this.#transport !== null;
  }
  get pid() {
    return this.#transport?.pid;
  }

  async #open(): Promise<Transport> {
    const c = this.c;
    const secrets: Record<string, string> = {};
    if (c.auth === "token") {
      const names = c.transport === "stdio" ? (c.secretEnv ?? []) : ["token"];
      for (const name of names) {
        const v = await this.d.secrets.get(secretName(c.id, name));
        if (!v) throw new ConnectorError("connector_needs_token");
        secrets[name] = v;
      }
      if (!names.length) throw new ConnectorError("connector_needs_token");
    }
    this.secretValues = Object.values(secrets).filter((v) => v.length >= 6);
    if (c.transport === "stdio") {
      const server = c.server as { command: string; args: string[] };
      const env: Record<string, string> = {};
      for (const k of PASS_ENV) if (this.d.env[k] !== undefined) env[k] = this.d.env[k]!;
      return new StdioTransport(
        { command: server.command, args: server.args, env: { ...env, ...secrets } },
        this.d.platform,
      );
    }
    const url = (c.server as { url?: string }).url ?? "";
    const headers: Record<string, string> = secrets.token ? { authorization: `Bearer ${secrets.token}` } : {};
    return new HttpTransport(url, headers, this.d.fetch);
  }

  /** The live link, starting it if needed; a crashed server waits out its backoff first. */
  async #ensure(): Promise<Transport> {
    if (this.#stopped) throw new ConnectorError("connector_stopped");
    if (this.#transport) return this.#transport;
    if (this.#starting) return this.#starting;
    if (this.d.now() < this.#retryAt) throw new ConnectorError("connector_restarting");
    this.#starting = this.#boot().finally(() => (this.#starting = null));
    return this.#starting;
  }

  async #boot(): Promise<Transport> {
    const t = await this.#open();
    if (this.#stopped) throw new ConnectorError("connector_stopped");
    let initialized = false;
    try {
      await t.start(
        (method) => {
          if (method === "notifications/tools/list_changed") this.#tools = null;
        },
        (crashed) => {
          if (this.#transport === t) this.#transport = null;
          this.#tools = null;
          if (crashed && initialized) this.#crashed();
        },
      );
      const init = (await t.request(
        "initialize",
        {
          protocolVersion: CLIENT_PROTOCOL,
          capabilities: {},
          clientInfo: { name: "chalito-connections", version: this.d.version ?? "0.0.0" },
        },
        INIT_TIMEOUT_MS,
      )) as { protocolVersion?: unknown } | null;
      if (!init || typeof init !== "object") throw new ConnectorError("connector_protocol");
      if (t instanceof HttpTransport && typeof init.protocolVersion === "string") t.setProtocol(init.protocolVersion);
      t.notify("notifications/initialized");
      initialized = true;
    } catch (e) {
      await t.close().catch(() => undefined);
      this.#failed();
      const err = e instanceof ConnectorError ? e : new ConnectorError("connector_unavailable");
      this.d.event("connector.start_failed", { connector: this.c.id, error: err.code, attempt: this.#failures });
      throw err;
    }
    if (this.#stopped) {
      await t.close().catch(() => undefined);
      throw new ConnectorError("connector_stopped");
    }
    this.#transport = t;
    this.#readyAt = this.d.now();
    this.d.event("connector.started", {
      connector: this.c.id,
      source: this.c.source,
      transport: this.c.transport,
      restarts: this.#failures,
    });
    return t;
  }

  #failed() {
    this.#failures++;
    this.#retryAt = this.d.now() + backoffMs(this.#failures);
  }

  #crashed() {
    if (this.#stopped) return;
    if (this.d.now() - this.#readyAt > HEALTHY_MS) this.#failures = 0;
    this.#failed();
    const attempt = this.#failures;
    this.d.event("connector.crashed", { connector: this.c.id, attempt });
    if (attempt > MAX_RESTARTS) return void this.d.event("connector.gave_up", { connector: this.c.id, attempt });
    this.#restartTimer?.clear();
    this.#restartTimer = this.d.setTimer(() => {
      this.#restartTimer = null;
      if (this.#stopped || this.#transport || this.#starting) return;
      this.#retryAt = 0;
      void this.#ensure().then(
        () => this.d.event("connector.restarted", { connector: this.c.id, attempt }),
        () => undefined,
      );
    }, backoffMs(attempt));
  }

  async tools(): Promise<UpstreamTool[]> {
    const t = await this.#ensure();
    if (this.#tools) return this.#tools;
    const all: UpstreamTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && all.length < MAX_TOOLS; page++) {
      const r = (await t.request("tools/list", cursor ? { cursor } : {}, LIST_TIMEOUT_MS).catch((e: unknown) => {
        this.#expired(t, e);
        throw e;
      })) as {
        tools?: unknown;
        nextCursor?: unknown;
      } | null;
      if (!r || !Array.isArray(r.tools)) throw new ConnectorError("connector_protocol");
      for (const tool of r.tools)
        if (tool && typeof tool === "object" && typeof (tool as UpstreamTool).name === "string")
          all.push(tool as UpstreamTool);
      cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    this.#tools = all.slice(0, MAX_TOOLS);
    return this.#tools;
  }

  /** `onSecrets` gets the values this very server holds, so output is scrubbed even if it stops meanwhile. */
  async call(
    tool: string,
    args: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    onSecrets?: (values: string[]) => void,
  ): Promise<unknown> {
    const t = await this.#ensure();
    onSecrets?.([...this.secretValues]);
    return t.request("tools/call", { name: tool, arguments: args ?? {} }, timeoutMs, signal).catch((e: unknown) => {
      this.#expired(t, e);
      throw e;
    });
  }

  // A forgotten MCP session or a refused token needs a fresh start (and a fresh keychain read) next time.
  #expired(t: Transport, e: unknown) {
    const codes = ["connector_session_expired", "connector_unauthorized"];
    if (!(e instanceof ConnectorError && codes.includes(e.code)) || this.#transport !== t) return;
    this.#transport = null;
    this.#tools = null;
    void t.close().catch(() => undefined);
  }

  /** Stops for good (agent stop, uninstall, revoke-all): the process group is killed. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#restartTimer?.clear();
    this.#restartTimer = null;
    const starting = this.#starting;
    const t = this.#transport;
    this.#transport = null;
    this.#tools = null;
    this.secretValues = [];
    await t?.close().catch(() => undefined);
    await starting?.then((s) => s.close()).catch(() => undefined);
  }
}
