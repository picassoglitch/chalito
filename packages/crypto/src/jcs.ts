/**
 * RFC 8785 JSON Canonicalization Scheme.
 * Keys are sorted by UTF-16 code units, numbers use ECMAScript serialization
 * (what JSON.stringify does), and there is no insignificant whitespace.
 * Signatures cover these bytes, so every runtime (Node, bun, browser) must agree.
 */
export const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new TypeError(`JCS: unsupported type ${typeof value}`);
};
