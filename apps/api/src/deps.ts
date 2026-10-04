import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";

export interface AuditEvent {
  action: string;
  owner: string | null;
  actor: string;
  target?: string;
  meta?: Record<string, unknown>;
}

/** Audit log sink (Pub/Sub topic `audit` → BigQuery in prod). */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export interface ApiConfig {
  /** CHALITO_SSO_SECRET: shared with the Chalyb hub (HMAC-SHA256 launch tokens). */
  ssoSecret: string;
  /** CHALITO_ADMIN_TOKEN: the hub's bearer for /hub/tenants*. */
  adminToken: string;
  /** Recovery cool-down (decision #20, default 1 h). */
  recoveryCooldownMs: number;
  /** Allowed clock skew for signed requests. */
  skewMs: number;
}

export interface Deps {
  db: Firestore;
  auth: Auth;
  audit: AuditSink;
  config: ApiConfig;
  now: () => number;
}

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
