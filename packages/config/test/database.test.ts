import { describe, expect, it } from "vitest";
import { checkRole, pgOptions, poolMode } from "../src/database.js";

const SESSION = "postgres://u:p@aws-1-us-west-1.pooler.supabase.com:5432/postgres";
const TXN = "postgres://u:p@aws-1-us-west-1.pooler.supabase.com:6543/postgres";

describe("poolMode", () => {
  it("port 6543 is Supavisor's transaction pooler; anything else is session or direct", () => {
    expect(poolMode(TXN, undefined)).toBe("transaction");
    expect(poolMode(SESSION, undefined)).toBe("session");
    expect(poolMode("postgres://u:p@127.0.0.1:54322/postgres", undefined)).toBe("session");
  });
  it("DATABASE_POOL_MODE overrides the port (another transaction pooler, or a direct 6543)", () => {
    expect(poolMode(SESSION, "transaction")).toBe("transaction");
    expect(poolMode(TXN, "session")).toBe("session");
    expect(poolMode(TXN, "bogus")).toBe("transaction");
  });
  it("an unparseable url is treated as session (postgres.js reports it)", () => {
    expect(poolMode("not a url", undefined)).toBe("session");
  });
});

describe("pgOptions", () => {
  it("transaction pooler: no prepared statements and no startup role parameter", () => {
    const o = pgOptions(TXN, { role: "chalito_server", max: 10, mode: undefined });
    expect(o.prepare).toBe(false);
    expect(o.connection).toBeUndefined();
    expect(o.max).toBe(10);
  });
  it("session or direct: the role travels as a startup parameter, statements stay prepared", () => {
    const o = pgOptions(SESSION, { role: "chalito_server", max: 5, mode: undefined });
    expect(o.connection).toEqual({ role: "chalito_server" });
    expect(o.prepare).toBeUndefined();
    expect(pgOptions(SESSION, { max: 5, mode: undefined }).connection).toBeUndefined();
  });
  it("idle connections close, so bursts don't pin pooler slots", () => {
    const o = pgOptions(TXN, { max: 10, mode: undefined });
    expect(o.idle_timeout).toBeGreaterThan(0);
    expect(o.max_lifetime).toBeGreaterThan(0);
  });
});

describe("checkRole", () => {
  const as = (u: string) => async () => [{ u }];
  it("passes when the connection acts as the expected role, and with none expected", async () => {
    await expect(checkRole(as("chalito_server"), "chalito_server")).resolves.toBeUndefined();
    await expect(checkRole(as("postgres"), undefined)).resolves.toBeUndefined();
  });
  it("refuses a connection that acts as anyone else (e.g. the pooler dropped the role)", async () => {
    await expect(checkRole(as("postgres"), "chalito_server")).rejects.toThrow(
      "database connection acts as postgres, expected chalito_server",
    );
    await expect(checkRole(async () => [], "chalito_gateway")).rejects.toThrow("acts as nobody");
  });
});
