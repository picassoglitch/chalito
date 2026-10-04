import type { PhoneDeps } from "./phone/routes.js";
import type { StoreDeps } from "./store/routes.js";
import type { VoiceDeps } from "./voice/routes.js";
import type { ApiRepo, IdentityIssuer } from "./repo.js";
import type { McpStore } from "./oauth/model.js";

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
  repo: ApiRepo;
  /** OAuth server + MCP gateway writes (M10); those routes answer 503 without it. */
  mcp?: McpStore;
  identity: IdentityIssuer;
  audit: AuditSink;
  config: ApiConfig;
  now: () => number;
  /** Phone verification and channel opt-ins (/v1/phone), when Twilio Verify is configured. */
  phone?: PhoneDeps;
  /** Desktop push-to-talk (/v1/voice), when OpenAI is configured. */
  voice?: VoiceDeps;
  /** The pay-to-dress store (/v1/store), when the hub is configured. */
  store?: StoreDeps;
}

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
