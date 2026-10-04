import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Google's signing keys for the OIDC tokens Pub/Sub push and Cloud Tasks attach. */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface OidcExpectation {
  /** The audience configured on the subscription / task (the endpoint URL). */
  audience: string;
  /** The service account the push subscription or queue signs as. */
  email: string;
}

export type OidcVerifier = (authorization: string | undefined, expect: OidcExpectation) => Promise<boolean>;

/** Verifies `Authorization: Bearer <Google ID token>`: signature, issuer, audience, expiry and the signer's email. */
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
