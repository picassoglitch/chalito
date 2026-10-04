import { randomUUID } from "node:crypto";
import type { AgentEvent, ApprovalRequest, CallLine, DeviceEvent } from "@chalito/protocol";

/**
 * Everything the agent reads from or writes to the cloud. Firestore in production
 * (firestore-store.ts), in memory for tests. The agent never trusts what it reads here
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

  updateDevice(fields: { policyHash?: string; devMode?: unknown; lastSeenAt?: number }): Promise<void>;
  /** Also appended to the durable audit collection. */
  publishDeviceEvent(e: DeviceEvent): Promise<void>;
  /** Durable, create-only audit trail: users/{uid}/devices/{deviceId}/audit/{eid}. `meta` is already redacted. */
  audit(entry: AuditEntry): Promise<void>;

  /** users/{uid}.callBriefing.enabled (user setting; local policy must also allow it). */
  callBriefingEnabled(): Promise<boolean>;
  writeCallLine(id: string, line: CallLine): Promise<void>;
  deleteCallLine(id: string): Promise<void>;
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
  #approvalWatchers = new Map<string, (d: unknown) => void>();
  #commandWatcher: ((id: string, doc: Record<string, unknown>) => void) | null = null;
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
  async publishDeviceEvent(e: DeviceEvent) {
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
  async deleteCallLine(id: string) {
    this.callLines.delete(id);
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
