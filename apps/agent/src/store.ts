import { randomUUID } from "node:crypto";
import { sanitizeDeviceEvent } from "./redact.js";
import type {
  AgentEvent,
  ApprovalRequest,
  CallLine,
  DeviceEvent,
  Provider,
  ProviderConnectionDoc,
  SessionCard,
} from "@chalito/protocol";

/**
 * Everything the agent reads from or writes to the cloud. Supabase in production
 * (supabase-store.ts), in memory for tests. The agent never trusts what it reads here
 * beyond what a signature from its local trusted list proves.
 */
export interface AgentStore {
  createApproval(req: ApprovalRequest): Promise<void>;
  /** Calls back with the raw `decision` field whenever a client attaches one. */
  watchApproval(aid: string, onDecision: (decision: unknown) => void): () => void;
  resolveApproval(aid: string, status: ApprovalRequest["status"], reason: string, at: number): Promise<void>;

  writeEvent(e: AgentEvent): Promise<void>;
  upsertSession(sid: string, data: Record<string, unknown>): Promise<void>;

  watchCommands(onCommand: (id: string, doc: Record<string, unknown>) => void): () => void;
  deleteCommand(id: string): Promise<void>;

  /** `presence` is the desktop's {desktopActive}, reported through the panel's IPC. */
  updateDevice(fields: {
    policyHash?: string;
    devMode?: unknown;
    lastSeenAt?: number;
    presence?: { desktopActive: boolean };
  }): Promise<void>;
  /** Also appended to the durable audit collection. */
  publishDeviceEvent(e: DeviceEvent): Promise<void>;
  /** Durable, create-only audit trail: users/{uid}/devices/{deviceId}/audit/{eid}. `meta` is already redacted. */
  audit(entry: AuditEntry): Promise<void>;

  /**
   * ADR 0018: the account's endorsements, each with the endorsed device's directory state.
   * Cloud data: only `TrustedClientList.addEndorsed` (a signature from a locally trusted
   * client) decides anything.
   */
  listEndorsements(): Promise<EndorsementRow[]>;
  /** Of these client device ids, the ones the account's directory has revoked (review R-H5). */
  revokedClients(deviceIds: string[]): Promise<string[]>;
  /** Called when an endorsement is stored (pointer) and after every resync. */
  watchEndorsements(onChange: () => void): () => void;

  /** users/{uid}.callBriefing.enabled (user setting; local policy must also allow it). */
  callBriefingEnabled(): Promise<boolean>;
  writeCallLine(id: string, line: CallLine): Promise<void>;
  deleteCallLine(id: string): Promise<void>;

  /** MCP card sharing (migration 001800): on for this session, or for this whole device. Off by default. */
  mcpSharingOn(sid: string): Promise<boolean>;
  /**
   * The plaintext copy of a session card for MCP, only while sharing is on (RLS refuses it
   * otherwise). Turning sharing off deletes it in the database.
   */
  writeSharedCard(sid: string, card: SessionCard): Promise<void>;

  /** chalito.connections: this device's status for one provider (status only, never a secret). */
  upsertConnection(provider: Provider, doc: ProviderConnectionDoc): Promise<void>;
}

export interface EndorsementRow {
  deviceId: string;
  endorsement: unknown;
  /** The endorsed device is revoked in the directory (or missing). */
  revoked: boolean;
  /** Its passkey binding (signed by its own key), if it enrolled one. */
  webauthnBinding: unknown;
}

export interface AuditEntry {
  eid: string;
  t: number;
  type: string;
  meta: Record<string, unknown>;
  source: "agent" | "deviceEvent";
}

/** In-memory store with hooks for tests to play the phone and the cloud. */
export class MemoryStore implements AgentStore {
  approvals = new Map<string, ApprovalRequest & { decision?: unknown; resolvedAt?: number; reason?: string }>();
  events: AgentEvent[] = [];
  sessions = new Map<string, Record<string, unknown>>();
  device: Record<string, unknown> = {};
  deviceEvents: DeviceEvent[] = [];
  audits: AuditEntry[] = [];
  callLines = new Map<string, CallLine>();
  briefingEnabled = true;
  /** Sessions (or "device") with MCP card sharing on, and the plaintext cards written for them. */
  sharing = new Set<string>();
  sharedCards = new Map<string, SessionCard>();
  connections = new Map<Provider, ProviderConnectionDoc>();
  #approvalWatchers = new Map<string, (d: unknown) => void>();
  #commandWatcher: ((id: string, doc: Record<string, unknown>) => void) | null = null;
  endorsements: EndorsementRow[] = [];
  #endorsementWatcher: (() => void) | null = null;

  async listEndorsements() {
    return this.endorsements.map((e) => ({ ...e }));
  }
  /** Client devices the directory has revoked (test hook: the account revoked them). */
  revokedDevices = new Set<string>();
  async revokedClients(deviceIds: string[]) {
    return deviceIds.filter((id) => this.revokedDevices.has(id));
  }
  /** Test hook: the account revokes a device and points the agent at the devices table. */
  revokeInDirectory(deviceId: string) {
    this.revokedDevices.add(deviceId);
    this.#endorsementWatcher?.();
  }
  watchEndorsements(cb: () => void) {
    this.#endorsementWatcher = cb;
    return () => {
      this.#endorsementWatcher = null;
    };
  }
  /** Test hook: the cloud stores an endorsement and points the agent at it. */
  pushEndorsement(row: EndorsementRow) {
    this.endorsements.push(row);
    this.#endorsementWatcher?.();
  }
  commands = new Map<string, Record<string, unknown>>();

  async createApproval(req: ApprovalRequest) {
    this.approvals.set(req.aid, { ...req });
  }
  watchApproval(aid: string, cb: (d: unknown) => void) {
    this.#approvalWatchers.set(aid, cb);
    return () => this.#approvalWatchers.delete(aid);
  }
  async resolveApproval(aid: string, status: ApprovalRequest["status"], reason: string, at: number) {
    const a = this.approvals.get(aid);
    if (a) Object.assign(a, { status, reason, resolvedAt: at });
  }
  async writeEvent(e: AgentEvent) {
    this.events.push(e);
  }
  async upsertSession(sid: string, data: Record<string, unknown>) {
    this.sessions.set(sid, { ...this.sessions.get(sid), ...data });
  }
  watchCommands(cb: (id: string, doc: Record<string, unknown>) => void) {
    this.#commandWatcher = cb;
    for (const [id, doc] of this.commands) cb(id, doc);
    return () => (this.#commandWatcher = null);
  }
  async deleteCommand(id: string) {
    this.commands.delete(id);
  }
  async updateDevice(fields: Record<string, unknown>) {
    Object.assign(this.device, fields);
  }
  async publishDeviceEvent(raw: DeviceEvent) {
    const e = sanitizeDeviceEvent(raw);
    this.deviceEvents.push(e);
    this.audits.push({ eid: randomUUID(), t: e.t, type: e.type, meta: { ...e }, source: "deviceEvent" });
  }
  async audit(entry: AuditEntry) {
    this.audits.push(entry);
  }
  async callBriefingEnabled() {
    return this.briefingEnabled;
  }
  async writeCallLine(id: string, line: CallLine) {
    this.callLines.set(id, line);
  }
  async mcpSharingOn(sid: string) {
    return this.sharing.has(sid) || this.sharing.has("device");
  }
  async writeSharedCard(sid: string, card: SessionCard) {
    if (!(await this.mcpSharingOn(sid))) throw new Error("sharing is off"); // as RLS would refuse it
    this.sharedCards.set(sid, card);
  }
  async deleteCallLine(id: string) {
    this.callLines.delete(id);
  }
  async upsertConnection(provider: Provider, doc: ProviderConnectionDoc) {
    this.connections.set(provider, { ...doc, cli: { ...doc.cli } });
  }

  // ---- test helpers (the phone / the cloud) ----
  attachDecision(aid: string, decision: unknown) {
    const a = this.approvals.get(aid);
    if (a) a.decision = decision;
    this.#approvalWatchers.get(aid)?.(decision);
  }
  sendCommand(id: string, doc: Record<string, unknown>) {
    this.commands.set(id, doc);
    this.#commandWatcher?.(id, doc);
  }
  pendingApprovals() {
    return [...this.approvals.values()].filter((a) => a.status === "pending");
  }
}
