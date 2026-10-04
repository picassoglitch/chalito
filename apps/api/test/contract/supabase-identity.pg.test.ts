import { randomUUID } from "node:crypto";
import { AuthClient } from "@supabase/supabase-js";
import { describe, it } from "vitest";
import { SupabaseIssuer } from "../../src/supabase/identity.js";
import { runIdentityContract } from "./identity.contract.js";

/**
 * IdentityIssuer contract against Supabase Auth: the local stack in CI (`supabase status`),
 * or a bare Auth server. SUPABASE_AUTH_URL is the Auth base (`<API_URL>/auth/v1` on the
 * stack); the service key is server only; the anon/publishable key plays the client.
 */
const url = process.env.SUPABASE_AUTH_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY ?? "";

const client = (key: string) =>
  new AuthClient({
    url: url!,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    autoRefreshToken: false,
    persistSession: false,
  });

if (url && serviceKey) {
  const admin = client(serviceKey);
  runIdentityContract("SupabaseIssuer", () => ({
    issuer: new SupabaseIssuer(admin),
    toBearer: async (tokenHash) => {
      const { data, error } = await client(anonKey).verifyOtp({ token_hash: tokenHash, type: "magiclink" });
      if (error || !data.session) throw error ?? new Error("no session");
      return data.session.access_token;
    },
    makeOwner: async () => {
      const { data, error } = await admin.admin.createUser({
        email: `hub-${randomUUID()}@example.invalid`,
        email_confirm: true,
      });
      if (error || !data.user) throw error ?? new Error("no user");
      return data.user.id;
    },
  }));
} else {
  describe("IdentityIssuer contract: SupabaseIssuer", () => {
    it.skip("needs SUPABASE_AUTH_URL and SUPABASE_SERVICE_ROLE_KEY", () => {});
  });
}
