import type { BucketStore } from "@chalito/guard";
import type { PhoneDeps } from "./phone/routes.js";
import type { AccountDeps } from "./account/routes.js";
import type { BillingDeps } from "./billing/routes.js";
import type { StoreDeps } from "./store/routes.js";
import type { VoiceDeps } from "./voice/routes.js";
import type { ReleaseStore } from "./releases/gcs.js";
import type { ApiRepo, IdentityIssuer } from "./repo.js";
import type { McpStore } from "./oauth/model.js";
import type { RoomsRepo } from "./rooms/repo.js";

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
  /** Proxies in front of Cloud Run that append to X-Forwarded-For (an external load balancer: 1). */
  trustedProxies?: number;
  /**
   * Browser origins allowed to call the api (CORS): the web app (CHALITO_WEB_ORIGIN) and the desktop
   * webview (CHALITO_DESKTOP_ORIGINS). Exact matches only. Absent or empty: no CORS headers.
   */
  corsOrigins?: readonly string[];
}

export interface Deps {
  /** Account deletion and export (/v1/account, /tasks/account-deletions), when storage is configured. */
  account?: AccountDeps;
  /** Shared rate buckets for the routes marked `shared` in src/limits.ts (Postgres in production). */
  rateBuckets?: BucketStore;
  repo: ApiRepo;
  /** OAuth server + MCP gateway writes (M10); those routes answer 503 without it. */
  mcp?: McpStore;
  /** Rooms (M11); routes answer 503 without it. */
  rooms?: RoomsRepo;
  identity: IdentityIssuer;
  audit: AuditSink;
  /**
   * The signed curated recipe catalog (GET /v1/recipes/catalog), e.g. read from
   * CHALITO_RECIPE_CATALOG_FILE. Unset: the route answers 404 (agents keep their built-in catalog).
   */
  recipeCatalog?: () => Promise<unknown | null>;
  /** The private releases bucket (ADR 0014). Unset (dev, tests): /releases isn't mounted. */
  releases?: ReleaseStore;
  config: ApiConfig;
  now: () => number;
  /** Phone verification and channel opt-ins (/v1/phone), when Twilio Verify is configured. */
  phone?: PhoneDeps;
  /** Desktop push-to-talk (/v1/voice), when OpenAI is configured. */
  voice?: VoiceDeps;
  /** The pay-to-dress store (/v1/store), when the hub is configured. */
  store?: StoreDeps;
  /** The owner's hub balance for /creditos (/v1/billing), when the hub is configured. */
  billing?: BillingDeps;
}

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
