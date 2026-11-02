import { randomUUID } from "node:crypto";
import type { AdapterKind, AgentEvent } from "@chalito/protocol";
import type { AgentCore } from "../agent-core.js";
import type { AgentStore } from "../store.js";
import type { ConnectorGate, ProxyClient } from "./proxy.js";

export const CONNECTOR_SID_PREFIX = "connector-";
const APP_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ADAPTER: Record<string, AdapterKind> = {
  "claude-code": "claude-code",
  claude: "claude-code",
  codex: "codex",
  cursor: "acp",
  "cursor-cli": "acp",
  grok: "grok",
  gemini: "gemini",
};
const APP: Record<string, string> = { claude: "claude-code", cursor: "cursor-cli" };

interface ClientSession {
  sid: string;
  seq: number;
  ready: Promise<void>;
  tail: Promise<void>;
}

/** The app id a `connections mcp <app>` argument names, or null when it isn't one. */
export const clientApp = (arg: string | undefined): string | null => {
  if (!arg) return null;
  const id = APP[arg] ?? arg;
  return APP_ID.test(id) ? id : null;
};

/** One session row per connected app, so its connector approvals show up on the phone like a native app's. */
export class ConnectorSessions {
  #byClient = new Map<string, ClientSession>();
  constructor(
    private readonly d: {
      core: Pick<AgentCore, "requestConnectorTool">;
      store: AgentStore;
      deviceId: string;
      now: () => number;
      log?: (event: string, meta: Record<string, unknown>) => void;
    },
  ) {}

  #event(s: ClientSession, event: Record<string, unknown>): Promise<void> {
    const seq = s.seq++;
    const write = s.tail.then(() =>
      this.d.store.writeEvent({
        v: 1,
        eid: randomUUID(),
        sid: s.sid,
        deviceId: this.d.deviceId,
        seq,
        t: this.d.now(),
        urgency: "normal",
        ...event,
      } as AgentEvent),
    );
    s.tail = write.catch(() => undefined);
    return write;
  }

  #session(client: ProxyClient): ClientSession {
    const s = this.#byClient.get(client.key);
    if (s) return s;
    const appId = client.app ?? "mcp-client";
    const adapter = ADAPTER[appId] ?? "acp";
    const created: ClientSession = {
      sid: `${CONNECTOR_SID_PREFIX}${randomUUID()}`,
      seq: 0,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
    };
    created.ready = (async () => {
      await this.d.store.upsertSession(created.sid, {
        deviceId: this.d.deviceId,
        adapter,
        appId,
        kind: "agent",
        control: "approvals",
        label: "Conexiones",
        cwdLabel: "Conexiones",
        state: "running",
        live: true,
        permissionMode: "default",
        updatedAt: this.d.now(),
      });
      await this.#event(created, { type: "session.started", adapter, origin: "local:cli", permissionMode: "default" });
    })().catch((error: unknown) => {
      if (this.#byClient.get(client.key) === created) this.#byClient.delete(client.key);
      throw error;
    });
    this.#byClient.set(client.key, created);
    return created;
  }

  readonly gate: ConnectorGate = async (call) => {
    const s = this.#session(call.client);
    try {
      await s.ready;
    } catch (error) {
      this.d.log?.("connector.session_failed", { error: error instanceof Error ? error.message : "error" });
      return { allow: false, reason: "unavailable" };
    }
    return this.d.core.requestConnectorTool({
      sid: s.sid,
      toolName: `mcp__${call.name}`,
      input: call.args,
      stamp: call.stamp,
      signal: call.signal,
      onRequested: (aid, expiresAt, risk) =>
        void this.#event(s, { type: "approval.requested", aid, risk, expiresAt }).catch((error: unknown) =>
          this.d.log?.("connector.announce_failed", { error: error instanceof Error ? error.message : "error" }),
        ),
    });
  };

  /** The app's connection closed: its session ends. */
  async end(clientKey: string): Promise<void> {
    const s = this.#byClient.get(clientKey);
    if (!s) return;
    this.#byClient.delete(clientKey);
    try {
      await s.ready;
      await this.d.store.upsertSession(s.sid, { state: "completed", live: false, updatedAt: this.d.now() });
      await this.#event(s, { type: "session.state", state: "completed" });
    } catch (error) {
      this.d.log?.("connector.session_end_failed", { error: error instanceof Error ? error.message : "error" });
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#byClient.keys()].map((k) => this.end(k)));
  }
}
