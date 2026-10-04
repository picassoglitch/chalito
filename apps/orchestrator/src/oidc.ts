import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Google OIDC for Cloud Scheduler tasks (same check as the notifier's). */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface OidcExpectation {
  audience: string;
  email: string;
}
export type OidcVerifier = (authorization: string | undefined, expect: OidcExpectation) => Promise<boolean>;

export const googleOidcVerifier =
  (keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))): OidcVerifier =>
  async (authorization, expect) => {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return false;
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: ISSUERS, audience: expect.audience });
      return payload.email === expect.email && payload.email_verified === true;
    } catch {
      return false;
    }
  };
