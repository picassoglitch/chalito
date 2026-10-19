/**
 * The services' Postgres connection settings (postgres.js options), shared so every service talks
 * to the pooler the same way.
 *
 * Supavisor's transaction pooler (port 6543, or DATABASE_POOL_MODE=transaction) hands each
 * transaction to whichever server connection is free. So: no prepared statements (another client's
 * connection doesn't have them), and no startup parameters such as `role` (the pooler refuses or
 * drops them; a SET would leak to other clients). The role comes from the login instead: a login
 * member of the role whose default is set (`alter role <login> set role <role>`), and `checkRole`
 * makes the service refuse to start if it isn't. Direct and session-pooled URLs keep the startup
 * `role` parameter, as local runs and CI do.
 */
export type PoolMode = "session" | "transaction";

export const poolMode = (url: string, mode: string | undefined = process.env.DATABASE_POOL_MODE): PoolMode => {
  if (mode === "transaction" || mode === "session") return mode;
  try {
    return new URL(url).port === "6543" ? "transaction" : "session";
  } catch {
    return "session";
  }
};

export interface PgOptions {
  max: number;
  onnotice: () => void;
  /** Seconds before an idle client connection closes, so bursts don't pin pooler slots. */
  idle_timeout: number;
  /** Seconds a connection lives at most. */
  max_lifetime: number;
  prepare?: false;
  connection?: { role: string };
}

export const pgOptions = (
  url: string,
  o: { role?: string | undefined; max: number; mode?: string | undefined },
): PgOptions => {
  const base = { max: o.max, onnotice: () => {}, idle_timeout: 20, max_lifetime: 30 * 60 };
  if (poolMode(url, o.mode) === "transaction") return { ...base, prepare: false };
  return o.role ? { ...base, connection: { role: o.role } } : base;
};

/** Runs `select current_user`; postgres.js's tagged template fits. */
export type CurrentUserQuery = (strings: TemplateStringsArray) => Promise<readonly { u: string }[]>;

/**
 * With a role expected, the connection must act as it: least privilege is enforced here at start
 * instead of trusting the pooler. Throws, so the service never serves as the wrong role.
 */
export const checkRole = async (sql: CurrentUserQuery, role: string | undefined): Promise<void> => {
  if (!role) return;
  const [r] = await sql`select current_user as u`;
  if (r?.u !== role) throw new Error(`database connection acts as ${r?.u ?? "nobody"}, expected ${role}`);
};
