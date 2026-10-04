import postgres, { type Sql, type TransactionSql } from "postgres";
import type { DeviceDoc, DeviceRegistration, Endorsement, PairingCodeDoc } from "@chalito/protocol";
import type {
  ApiRepo,
  EndorseCodeRecord,
  NewEndorseCode,
  StoredRecovery,
  StoredWebAuthnCredential,
  TenantRecord,
  TenantStatus,
  WebAuthnChallenge,
  WebAuthnPurpose,
} from "../repo.js";

/**
 * ApiRepo over the `chalito` schema (supabase/migrations). Runs as `chalito_server` (least
 * privilege, reaching rows through its server_all policies; see `chalitoSql`). Times are epoch
 * ms in the API and timestamptz in the database. Atomic methods are single transactions.
 */
export interface PostgresRepoOptions {
  /**
   * The Auth user id a device / pairing watch signs in as (SupabaseIssuer's
   * `chalitoAuthUserId`). Written to devices.auth_user_id and pairing_codes.watch_auth_user_id
   * in the same statement that creates the row; RLS requires the token's sub to match.
   */
  authUserId?: (kind: "device" | "pairing", id: string) => string;
}

/** A connection that acts as `chalito_server` (or the role given), e.g. from a postgres login granted that role. */
export const chalitoSql = (url: string, opts: { role?: string; max?: number } = {}): Sql =>
  postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    ...(opts.role ? { connection: { role: opts.role } } : {}),
  });

export class PostgresRepo implements ApiRepo {
  constructor(
    private readonly sql: Sql,
    private readonly opts: PostgresRepoOptions = {},
  ) {}

  #authUser(kind: "device" | "pairing", id: string) {
    return this.opts.authUserId ? this.opts.authUserId(kind, id) : null;
  }

  // ---- tenants / users -------------------------------------------------------------

  async createTenant(t: TenantRecord) {
    return this.sql.begin(async (tx) => {
      await tx`insert into chalito.tenants (id, created_at) values (${t.tenantId}, ${ts(t.createdAt)})
               on conflict (id) do nothing`;
      const rows = await tx`
        insert into chalito.users (id, tenant_id, email, display_name, tier, status, locale, created_at)
        values (${t.tenantId}, ${t.tenantId}, ${t.email}, ${t.displayName}, ${t.tier}, 'active', 'es', ${ts(t.createdAt)})
        on conflict (id) do nothing
        returning id`;
      return rows.length ? ("created" as const) : ("exists" as const);
    });
  }

  async setTenantStatus(tenantId: string, status: TenantStatus, at: number) {
    const rows = await this.sql`
      update chalito.users set status = ${status}, status_at = ${ts(at)} where id = ${tenantId} returning id`;
    return rows.length > 0;
  }

  async upsertUserFromSso(owner: string, f: { tenantId: string; email: string; tier: string; lastSsoAt: number }) {
    await this.sql.begin(async (tx) => {
      await tx`insert into chalito.tenants (id) values (${f.tenantId}) on conflict (id) do nothing`;
      await tx`
        insert into chalito.users (id, tenant_id, email, tier, last_sso_at)
        values (${owner}, ${f.tenantId}, ${f.email}, ${f.tier}, ${ts(f.lastSsoAt)})
        on conflict (id) do update
          set tenant_id = excluded.tenant_id, email = excluded.email, tier = excluded.tier,
              last_sso_at = excluded.last_sso_at`;
    });
  }

  // ---- single-use markers ------------------------------------------------------------

  async claimSsoToken(sigHash: string, expiresAt: number) {
    const rows = await this.sql`
      insert into chalito_private.sso_tokens (sig_hash, expires_at) values (${sigHash}, ${ts(expiresAt)})
      on conflict (sig_hash) do nothing returning sig_hash`;
    return rows.length > 0;
  }

  async claimDeviceNonce(deviceId: string, nonce: string, expiresAt: number) {
    const rows = await this.sql`
      insert into chalito_private.device_nonces (device_id, nonce, expires_at)
      values (${deviceId}, ${nonce}, ${ts(expiresAt)})
      on conflict (device_id, nonce) do nothing returning nonce`;
    return rows.length > 0;
  }

  // ---- devices -----------------------------------------------------------------------

  async getDevice(owner: string, deviceId: string) {
    const [row] = await this.sql<DeviceRow[]>`
      select * from chalito.devices where owner = ${owner} and device_id = ${deviceId}`;
    return row ? toDevice(row) : null;
  }

  async createDevice(owner: string, doc: DeviceDoc) {
    // device_id is unique across owners (derived from the device's keys).
    const rows = await insertDevice(this.sql, owner, doc, this.#authUser("device", doc.deviceId), true);
    return rows.length ? ("created" as const) : ("exists" as const);
  }

  async touchDevice(owner: string, deviceId: string, at: number) {
    await this
      .sql`update chalito.devices set last_seen_at = ${ts(at)} where owner = ${owner} and device_id = ${deviceId}`;
  }

  async revokeDevice(owner: string, deviceId: string, at: number, by: string | null) {
    // One statement: the row lock makes exactly one concurrent caller see revoked = false.
    const rows = await this.sql`
      update chalito.devices set revoked = true, revoked_at = ${ts(at)}, revoked_by = ${by}
      where owner = ${owner} and device_id = ${deviceId} and revoked = false
      returning device_id`;
    if (rows.length) return "revoked" as const;
    const [exists] = await this.sql`select 1 from chalito.devices where owner = ${owner} and device_id = ${deviceId}`;
    return exists ? ("already_revoked" as const) : ("not_found" as const);
  }

  async enrollFirstClient(owner: string, doc: DeviceDoc, recovery: StoredRecovery) {
    return this.sql.begin(async (tx) => {
      // Serialises enrolments per account: concurrent callers queue on the user row.
      await lockUser(tx, owner);
      const [active] = await tx`
        select 1 from chalito.devices where owner = ${owner} and role = 'client' and revoked = false limit 1`;
      if (active) return "client_exists" as const;
      if (await deviceIdTaken(tx, doc.deviceId)) return "device_exists" as const;
      await insertDevice(tx, owner, doc, this.#authUser("device", doc.deviceId), false);
      await upsertRecovery(tx, owner, recovery);
      return "ok" as const;
    });
  }

  // ---- WebAuthn ----

  async putWebAuthnChallenge(c: WebAuthnChallenge) {
    await this.sql`
      insert into chalito_private.webauthn_challenges (owner, device_id, purpose, challenge, expires_at)
      values (${c.owner}, ${c.deviceId}, ${c.purpose}, ${c.challenge}, ${ts(c.expiresAt)})
      on conflict (owner, device_id, purpose)
        do update set challenge = excluded.challenge, expires_at = excluded.expires_at`;
  }

  async takeWebAuthnChallenge(owner: string, deviceId: string, purpose: WebAuthnPurpose, now: number) {
    // One statement: concurrent takers can't both get the same challenge.
    const [row] = await this.sql<{ challenge: string; expires_at: Date }[]>`
      delete from chalito_private.webauthn_challenges
      where owner = ${owner} and device_id = ${deviceId} and purpose = ${purpose}
      returning challenge, expires_at`;
    return row && row.expires_at.getTime() > now ? row.challenge : null;
  }

  async setDeviceWebAuthn(owner: string, deviceId: string, cred: StoredWebAuthnCredential) {
    const rows = await this.sql`
      update chalito.devices
      set webauthn_credential_id = ${cred.credentialId}, webauthn_public_key = ${cred.publicKey},
          webauthn_rp_id = ${cred.rpId}, webauthn_counter = ${cred.counter},
          webauthn_transports = ${cred.transports}, webauthn_created_at = ${ts(cred.createdAt)},
          webauthn_binding = null
      where owner = ${owner} and device_id = ${deviceId}
      returning device_id`;
    return rows.length > 0;
  }

  async getDeviceWebAuthn(owner: string, deviceId: string) {
    const [r] = await this.sql<
      {
        webauthn_credential_id: string | null;
        webauthn_public_key: string;
        webauthn_rp_id: string;
        webauthn_counter: string | number;
        webauthn_transports: string[] | null;
        webauthn_created_at: Date;
        webauthn_binding: unknown;
      }[]
    >`
      select webauthn_credential_id, webauthn_public_key, webauthn_rp_id, webauthn_counter,
             webauthn_transports, webauthn_created_at, webauthn_binding
      from chalito.devices where owner = ${owner} and device_id = ${deviceId}`;
    if (!r?.webauthn_credential_id) return null;
    return {
      credentialId: r.webauthn_credential_id,
      publicKey: r.webauthn_public_key,
      rpId: r.webauthn_rp_id,
      counter: Number(r.webauthn_counter),
      transports: r.webauthn_transports ?? [],
      createdAt: r.webauthn_created_at.getTime(),
      binding: r.webauthn_binding ?? null,
    };
  }

  async bumpWebAuthnCounter(owner: string, deviceId: string, credentialId: string, counter: number) {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ webauthn_counter: string | number }[]>`
        select webauthn_counter from chalito.devices
        where owner = ${owner} and device_id = ${deviceId} and webauthn_credential_id = ${credentialId}
        for update`;
      if (!row) return "not_found" as const;
      const stored = Number(row.webauthn_counter);
      if (counter === 0 && stored === 0) return "ok" as const;
      if (counter <= stored) return "cloned" as const;
      await tx`update chalito.devices set webauthn_counter = ${counter}
               where owner = ${owner} and device_id = ${deviceId}`;
      return "ok" as const;
    });
  }

  async setDeviceWebAuthnBinding(owner: string, deviceId: string, binding: unknown) {
    const rows = await this.sql`
      update chalito.devices set webauthn_binding = ${this.sql.json(binding as never)}
      where owner = ${owner} and device_id = ${deviceId} and not revoked and webauthn_credential_id is not null
      returning device_id`;
    return rows.length > 0;
  }

  async saveEndorsement(owner: string, newDeviceId: string, endorsement: unknown, at: number) {
    await this.sql`
      insert into chalito.endorsements (owner, device_id, endorsement, created_at)
      values (${owner}, ${newDeviceId}, ${this.sql.json(endorsement as never)}, ${ts(at)})
      on conflict (owner, device_id) do nothing`;
  }

  // ---- recovery ----------------------------------------------------------------------

  async getRecovery(owner: string) {
    const [row] = await this.sql<RecoveryRow[]>`
      select code_hash, cooldown_until, started_at, created_at from chalito_private.private_recovery where owner = ${owner}`;
    if (!row) return null;
    return {
      ...(row.code_hash as StoredRecovery),
      cooldownUntil: ms(row.cooldown_until),
      createdAt: row.created_at.getTime(),
      ...(row.started_at ? { startedAt: row.started_at.getTime() } : {}),
    };
  }

  async startRecovery(owner: string, cooldownUntil: number, startedAt: number) {
    await this.sql`
      update chalito_private.private_recovery set cooldown_until = ${ts(cooldownUntil)}, started_at = ${ts(startedAt)}
      where owner = ${owner}`;
  }

  async completeRecovery(owner: string, doc: DeviceDoc, next: StoredRecovery) {
    return this.sql.begin(async (tx) => {
      await lockUser(tx, owner);
      if (await deviceIdTaken(tx, doc.deviceId)) return "device_exists" as const;
      await insertDevice(tx, owner, doc, this.#authUser("device", doc.deviceId), false);
      await upsertRecovery(tx, owner, next);
      return "ok" as const;
    });
  }

  // ---- notifications -----------------------------------------------------------------

  async createNotification(owner: string, nid: string, d: Record<string, unknown>) {
    await this.sql`
      insert into chalito.notifications
        (owner, nid, level, source, urgency, counts, deep_link, coalesce_key, state, step, next_at, channels,
         created_at, acked_at, acked_via)
      values (${owner}, ${nid}, ${d.level as string}, ${d.source as string}, ${d.urgency as string},
              ${this.sql.json((d.counts ?? {}) as never)}, ${d.deepLink as string}, ${d.coalesceKey as string},
              ${(d.state as string) ?? "pending"}, ${(d.step as number) ?? 0}, ${tsOrNull(d.nextAt)},
              ${(d.channels as string[]) ?? []}, ${tsOrNull(d.createdAt) ?? new Date()}, ${tsOrNull(d.ackedAt)},
              ${(d.ackedVia as string | null) ?? null})
      on conflict (owner, nid) do update set
        level = excluded.level, source = excluded.source, urgency = excluded.urgency, counts = excluded.counts,
        deep_link = excluded.deep_link, coalesce_key = excluded.coalesce_key, state = excluded.state,
        step = excluded.step, next_at = excluded.next_at, channels = excluded.channels,
        acked_at = excluded.acked_at, acked_via = excluded.acked_via`;
  }

  // ---- pairing -----------------------------------------------------------------------

  async createPairingCode(doc: PairingCodeDoc) {
    const rows = await this.sql`
      insert into chalito.pairing_codes
        (code_id, short_code_hash, glyph, agent_device_id, kind, platform, claimed, owner,
         claimed_by_device_id, claimer_pub_sign, claimer_pub_box, expires_at, watch_auth_user_id)
      values (${doc.codeId}, ${doc.shortCodeHash}, ${this.sql.json(doc.glyph as never)}, ${doc.agentDeviceId},
              ${doc.kind}, ${doc.platform}, ${doc.claimed}, ${doc.owner}, ${doc.claimedByDeviceId},
              ${doc.claimerPubSign}, ${doc.claimerPubBox}, ${ts(doc.expiresAt)},
              ${this.#authUser("pairing", doc.codeId)})
      on conflict (code_id) do nothing
      returning code_id`;
    return rows.length ? ("created" as const) : ("exists" as const);
  }

  async findPairingCodeByShortHash(shortCodeHash: string) {
    const [row] = await this.sql<PairingRow[]>`
      select * from chalito.pairing_codes where short_code_hash = ${shortCodeHash}`;
    return row ? toPairingCode(row) : null;
  }

  async releasePairingWatches(owner: string, agentDeviceId: string) {
    const rows = await this.sql<{ code_id: string }[]>`
      update chalito.pairing_codes set watch_auth_user_id = null
      where owner = ${owner} and agent_device_id = ${agentDeviceId} and claimed and watch_auth_user_id is not null
      returning code_id`;
    return rows.map((r) => r.code_id);
  }

  async claimPairingCode(
    codeId: string,
    claim: {
      owner: string;
      claimedByDeviceId: string;
      claimerPubSign: string;
      claimerPubBox: string;
      claimerWebauthnBinding?: unknown;
      claimedAt: number;
    },
    build: (code: PairingCodeDoc) => Promise<DeviceDoc>,
  ) {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<PairingRow[]>`select * from chalito.pairing_codes where code_id = ${codeId} for update`;
      if (!row) return { ok: false as const, reason: "not_found" as const };
      if (row.claimed) return { ok: false as const, reason: "already_claimed" as const };
      // `build` may throw: the transaction rolls back and the error propagates.
      const agent = await build(toPairingCode(row));
      if (await deviceIdTaken(tx, agent.deviceId)) return { ok: false as const, reason: "device_exists" as const };
      await insertDevice(tx, claim.owner, agent, this.#authUser("device", agent.deviceId), false);
      await tx`
        update chalito.pairing_codes set claimed = true, owner = ${claim.owner},
          claimed_by_device_id = ${claim.claimedByDeviceId}, claimer_pub_sign = ${claim.claimerPubSign},
          claimer_pub_box = ${claim.claimerPubBox}, claimed_at = ${ts(claim.claimedAt)},
          claimer_webauthn_binding = ${claim.claimerWebauthnBinding ? this.sql.json(claim.claimerWebauthnBinding as never) : null}
        where code_id = ${codeId}`;
      return { ok: true as const, agentDeviceId: agent.deviceId };
    });
  }

  // ---- endorsement handoff -------------------------------------------------------------

  async createEndorseCode(r: NewEndorseCode) {
    const rows = await this.sql`
      insert into chalito.endorse_codes
        (code_id, short_code_hash, owner, new_device_id, registration, expires_at, watch_auth_user_id)
      values (${r.codeId}, ${r.shortCodeHash}, ${r.owner}, ${r.registration.body.deviceId},
              ${this.sql.json(r.registration as never)}, ${ts(r.expiresAt)}, ${this.#authUser("pairing", r.codeId)})
      on conflict do nothing
      returning code_id`;
    return rows.length ? ("created" as const) : ("exists" as const);
  }

  async findEndorseCode(codeId: string) {
    const [row] = await this.sql<EndorseRow[]>`select * from chalito.endorse_codes where code_id = ${codeId}`;
    return row ? toEndorseCode(row) : null;
  }

  async findEndorseCodeByShortHash(shortCodeHash: string) {
    const [row] = await this.sql<EndorseRow[]>`
      select * from chalito.endorse_codes where short_code_hash = ${shortCodeHash}`;
    return row ? toEndorseCode(row) : null;
  }

  async approveEndorseCode(
    codeId: string,
    owner: string,
    e: { endorsement: Endorsement; endorsedByDeviceId: string; endorsedAt: number },
    now: number,
  ) {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<EndorseRow[]>`
        select * from chalito.endorse_codes where code_id = ${codeId} and owner = ${owner} for update`;
      if (!row) return "not_found" as const;
      if (row.endorsement) return "already_endorsed" as const;
      if (row.expires_at.getTime() <= now) return "expired" as const;
      await tx`
        update chalito.endorse_codes set endorsement = ${tx.json(e.endorsement as never)},
          endorsed_by_device_id = ${e.endorsedByDeviceId}, endorsed_at = ${ts(e.endorsedAt)}
        where code_id = ${codeId}`;
      return "ok" as const;
    });
  }

  async takeEndorsement(codeId: string, owner: string, now: number) {
    return this.sql.begin(async (tx) => {
      const [row] = await tx<EndorseRow[]>`
        select * from chalito.endorse_codes where code_id = ${codeId} and owner = ${owner} for update`;
      if (!row) return { ok: false as const, reason: "not_found" as const };
      if (row.taken_at) return { ok: false as const, reason: "already_taken" as const };
      if (row.expires_at.getTime() <= now) return { ok: false as const, reason: "expired" as const };
      if (!row.endorsement) return { ok: false as const, reason: "not_endorsed" as const };
      await tx`update chalito.endorse_codes set taken_at = ${ts(now)}, watch_auth_user_id = null
               where code_id = ${codeId}`;
      return { ok: true as const, endorsement: row.endorsement as Endorsement };
    });
  }
}

// ---- helpers ---------------------------------------------------------------------------

type Q = Sql | TransactionSql;

const ts = (msValue: number) => new Date(msValue);
const tsOrNull = (v: unknown) => (typeof v === "number" ? new Date(v) : null);
const ms = (d: Date | null) => (d ? d.getTime() : null);

/** Locks the account's user row for the transaction. Throws if the user doesn't exist. */
const lockUser = async (tx: TransactionSql, owner: string) => {
  const [u] = await tx`select id from chalito.users where id = ${owner} for update`;
  if (!u) throw new Error(`unknown user ${owner}`);
};

const deviceIdTaken = async (tx: Q, deviceId: string) =>
  (await tx`select 1 from chalito.devices where device_id = ${deviceId}`).length > 0;

const insertDevice = (q: Q, owner: string, d: DeviceDoc, authUserId: string | null, ignoreConflict: boolean) => {
  const insert = q`
    insert into chalito.devices
      (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, endorsed_by,
       revoked, revoked_at, created_at, last_seen_at, policy_hash, dev_mode, auth_user_id)
    values (${owner}, ${d.deviceId}, ${d.role}, ${d.kind}, ${d.platform}, ${d.name}, ${d.pubSign}, ${d.pubBox},
            ${d.fingerprint}, ${d.enrolledVia}, ${d.endorsedBy}, ${d.revoked}, ${tsOrNull(d.revokedAt)},
            ${ts(d.createdAt)}, ${tsOrNull(d.lastSeenAt)}, ${d.policyHash}, ${q.json(d.devMode as never)}, ${authUserId})`;
  return ignoreConflict ? q`${insert} on conflict do nothing returning device_id` : q`${insert} returning device_id`;
};

const upsertRecovery = (tx: TransactionSql, owner: string, r: StoredRecovery) => {
  const { cooldownUntil, createdAt, startedAt, ...codeHash } = r;
  return tx`
    insert into chalito_private.private_recovery (owner, code_hash, cooldown_until, started_at, created_at)
    values (${owner}, ${tx.json(codeHash as never)}, ${tsOrNull(cooldownUntil)}, ${tsOrNull(startedAt)},
            ${tsOrNull(createdAt) ?? new Date()})
    on conflict (owner) do update set code_hash = excluded.code_hash, cooldown_until = excluded.cooldown_until,
      started_at = excluded.started_at, created_at = excluded.created_at`;
};

interface DeviceRow {
  owner: string;
  device_id: string;
  role: DeviceDoc["role"];
  kind: DeviceDoc["kind"];
  platform: DeviceDoc["platform"];
  name: string;
  pub_sign: string;
  pub_box: string;
  fingerprint: string;
  enrolled_via: DeviceDoc["enrolledVia"];
  endorsed_by: string | null;
  revoked: boolean;
  revoked_at: Date | null;
  created_at: Date;
  last_seen_at: Date | null;
  policy_hash: string | null;
  dev_mode: DeviceDoc["devMode"];
}

const toDevice = (r: DeviceRow): DeviceDoc => ({
  v: 1,
  deviceId: r.device_id,
  owner: r.owner,
  kind: r.kind,
  platform: r.platform,
  name: r.name,
  role: r.role,
  pubSign: r.pub_sign,
  pubBox: r.pub_box,
  fingerprint: r.fingerprint,
  enrolledVia: r.enrolled_via,
  endorsedBy: r.endorsed_by,
  revoked: r.revoked,
  revokedAt: ms(r.revoked_at),
  createdAt: r.created_at.getTime(),
  lastSeenAt: ms(r.last_seen_at),
  policyHash: r.policy_hash,
  devMode: r.dev_mode,
});

interface PairingRow {
  code_id: string;
  short_code_hash: string;
  glyph: PairingCodeDoc["glyph"];
  agent_device_id: string;
  kind: PairingCodeDoc["kind"];
  platform: PairingCodeDoc["platform"];
  claimed: boolean;
  owner: string | null;
  claimed_by_device_id: string | null;
  claimer_pub_sign: string | null;
  claimer_pub_box: string | null;
  claimer_webauthn_binding?: unknown;
  expires_at: Date;
}

interface EndorseRow {
  code_id: string;
  short_code_hash: string;
  owner: string;
  new_device_id: string;
  registration: DeviceRegistration;
  endorsement: Endorsement | null;
  endorsed_by_device_id: string | null;
  endorsed_at: Date | null;
  taken_at: Date | null;
  expires_at: Date;
}

const toEndorseCode = (r: EndorseRow): EndorseCodeRecord => ({
  codeId: r.code_id,
  shortCodeHash: r.short_code_hash,
  owner: r.owner,
  newDeviceId: r.new_device_id,
  registration: r.registration,
  endorsement: r.endorsement,
  endorsedByDeviceId: r.endorsed_by_device_id,
  endorsedAt: ms(r.endorsed_at),
  takenAt: ms(r.taken_at),
  expiresAt: r.expires_at.getTime(),
});

const toPairingCode = (r: PairingRow): PairingCodeDoc => ({
  v: 1,
  codeId: r.code_id,
  shortCodeHash: r.short_code_hash,
  glyph: r.glyph,
  agentDeviceId: r.agent_device_id,
  kind: r.kind,
  platform: r.platform,
  claimed: r.claimed,
  owner: r.owner,
  claimedByDeviceId: r.claimed_by_device_id,
  claimerPubSign: r.claimer_pub_sign,
  claimerPubBox: r.claimer_pub_box,
  claimerWebauthnBinding: (r.claimer_webauthn_binding ?? null) as PairingCodeDoc["claimerWebauthnBinding"],
  expiresAt: r.expires_at.getTime(),
});

interface RecoveryRow {
  code_hash: unknown;
  cooldown_until: Date | null;
  started_at: Date | null;
  created_at: Date;
}
