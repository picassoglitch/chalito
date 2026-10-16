import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import type { AgentCard } from "@chalito/protocol";

/**
 * Agents the owner exposes on Chalito's A2A server (ADR 0022 §4), one row each
 * (`chalito.a2a_exposures`, migration 20261015000400). Nothing is exposed by default. An
 * exposure only publishes a card: creating a task on it still needs an A2A grant with
 * `link:handoff` AND a LinkAuthorizer yes.
 */
export interface A2aExposure {
  owner: string;
  /** Opaque, unguessable: the A2A endpoint is `/a2a/<exposureId>`. */
  exposureId: string;
  appId: string;
  deviceId: string;
  /** A workspace the person allowed on that device (never a path). */
  workspaceLabel: string;
  /** The card body the owner's client built from the recipe (no interfaces or security; the server adds them). */
  card: AgentCard;
  createdAt: number;
  revokedAt: number | null;
}

export interface A2aStore {
  createExposure(e: A2aExposure): Promise<"ok" | "no_device">;
  listExposures(owner: string): Promise<A2aExposure[]>;
  /** A live (unrevoked) exposure by id, any owner. */
  getExposure(exposureId: string): Promise<A2aExposure | null>;
  revokeExposure(owner: string, exposureId: string, at: number): Promise<boolean>;
}

export const newExposureId = () => `a2x_${randomBytes(18).toString("base64url")}`;

export class MemoryA2aStore implements A2aStore {
  exposures = new Map<string, A2aExposure>();
  /** `${owner}/${deviceId}` of active agent devices. */
  agents = new Set<string>();
  async createExposure(e: A2aExposure) {
    if (!this.agents.has(`${e.owner}/${e.deviceId}`)) return "no_device" as const;
    this.exposures.set(e.exposureId, e);
    return "ok" as const;
  }
  async listExposures(owner: string) {
    return [...this.exposures.values()].filter((e) => e.owner === owner && e.revokedAt === null);
  }
  async getExposure(id: string) {
    const e = this.exposures.get(id);
    return e && e.revokedAt === null ? e : null;
  }
  async revokeExposure(owner: string, id: string, at: number) {
    const e = this.exposures.get(id);
    if (!e || e.owner !== owner || e.revokedAt !== null) return false;
    e.revokedAt = at;
    return true;
  }
}

interface Row {
  owner: string;
  exposure_id: string;
  app_id: string;
  device_id: string;
  workspace_label: string;
  card: AgentCard;
  created_at: Date;
  revoked_at: Date | null;
}
const fromRow = (r: Row): A2aExposure => ({
  owner: r.owner,
  exposureId: r.exposure_id,
  appId: r.app_id,
  deviceId: r.device_id,
  workspaceLabel: r.workspace_label,
  card: r.card,
  createdAt: r.created_at.getTime(),
  revokedAt: r.revoked_at ? r.revoked_at.getTime() : null,
});

/** On Postgres, as chalito_server. */
export class PostgresA2aStore implements A2aStore {
  constructor(private readonly sql: Sql) {}
  async createExposure(e: A2aExposure) {
    const [d] = await this.sql`select 1 from chalito.devices where owner = ${e.owner} and device_id = ${e.deviceId}
                               and role = 'agent' and not revoked`;
    if (!d) return "no_device" as const;
    await this.sql`
      insert into chalito.a2a_exposures (owner, exposure_id, app_id, device_id, workspace_label, card, created_at)
      values (${e.owner}, ${e.exposureId}, ${e.appId}, ${e.deviceId}, ${e.workspaceLabel},
              ${this.sql.json(e.card as never)}, ${new Date(e.createdAt)})`;
    return "ok" as const;
  }
  async listExposures(owner: string) {
    const rows = await this.sql<Row[]>`
      select * from chalito.a2a_exposures where owner = ${owner} and revoked_at is null order by created_at`;
    return rows.map(fromRow);
  }
  async getExposure(id: string) {
    const [r] = await this.sql<Row[]>`
      select * from chalito.a2a_exposures where exposure_id = ${id} and revoked_at is null`;
    return r ? fromRow(r) : null;
  }
  async revokeExposure(owner: string, id: string, at: number) {
    const r = await this.sql`
      update chalito.a2a_exposures set revoked_at = ${new Date(at)}
      where owner = ${owner} and exposure_id = ${id} and revoked_at is null`;
    return r.count > 0;
  }
}
