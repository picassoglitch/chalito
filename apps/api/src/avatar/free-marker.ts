import { createHmac } from "node:crypto";

/**
 * The free custom companion is once per person, even across account deletion and re-signup
 * (migration 20261005000200). A person is recognised by keyed hashes, never by the data itself:
 * HMAC-SHA256(key, "uid:<hub user id>") and HMAC-SHA256(key, "email:<email, trimmed, lowercased>").
 * The hub user id survives a Chalito account deletion (the hub account is the hub's); the email
 * also catches a new hub account made with the same address. Without the key the hashes can't be
 * matched against a list of emails.
 */
export const freeMarkers = (key: string, owner: string, email: string | null): string[] => {
  const h = (s: string) => createHmac("sha256", key).update(s).digest("hex");
  const out = [h(`uid:${owner}`)];
  const e = email?.trim().toLowerCase();
  if (e) out.push(h(`email:${e}`));
  return out;
};

/**
 * The marker key: AVATAR_FREE_MARKER_KEY when set; otherwise derived from the SSO secret, so a
 * deploy without the new secret still works (rotating the SSO secret then resets who has used
 * their free creation, which only costs one more free creation per person).
 */
export const markerKey = (dedicated: string | undefined, ssoSecret: string): string => {
  if (dedicated) {
    if (dedicated.length < 32) throw new Error("AVATAR_FREE_MARKER_KEY must be at least 32 characters");
    return dedicated;
  }
  return createHmac("sha256", ssoSecret).update("chalito.avatar.free-marker.v1").digest("hex");
};
