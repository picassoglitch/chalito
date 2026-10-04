import { timingSafeEqual } from "node:crypto";

/** `Authorization: Bearer <token>` against a configured secret, in constant time; an empty secret never matches. */
export const bearerOk = (header: string | undefined, token: string): boolean => {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return token.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
};
