import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { PairingApproval, PairingNetwork } from "@chalito/protocol";

/**
 * The network signal of hand-off pairing (ADR 0028 §4, THREAT_MODEL §4.5 "Pairing phishing via
 * hand-off link"). The api remembers which public network asked for a pairing code and compares
 * it with the network of the browser that approves it, for the warning only (decision #52: it
 * never grants one tap). Only a keyed hash of the network is kept
 * (IPv4 address, or the /64 of an IPv6 address), never the address itself, and only while the
 * code is open (migration 20261016000100).
 */

export interface PairingNet {
  family: 4 | 6;
  /** HMAC-SHA256 of the network, hex. */
  netHash: string;
  /** Coarse place from the platform's geo header, when there is one. */
  city: string | null;
}

/** IPv4 as is (also IPv4-mapped IPv6), IPv6 by its /64; null for anything that isn't an address. */
export const networkOf = (ip: string): { family: 4 | 6; net: string } | null => {
  const raw = ip
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  if (mapped && isIPv4(mapped[1]!)) return { family: 4, net: mapped[1]! };
  if (isIPv4(raw)) return { family: 4, net: raw };
  if (!isIPv6(raw)) return null;
  const [head = "", tail = ""] = raw.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (t.some((g) => g.includes(".")) || h.some((g) => g.includes("."))) return null;
  const groups = raw.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return {
    family: 6,
    net: groups
      .slice(0, 4)
      .map((g) => parseInt(g, 16).toString(16))
      .join(":"),
  };
};

const CITY_HEADERS = ["x-client-geo-city", "x-appengine-city"];

/**
 * Coarse location the platform adds (a load balancer custom header); none on plain Cloud Run.
 * Only trust it behind a proxy that sets it: a client can send these headers itself.
 */
export const cityOf = (header: (name: string) => string | undefined): string | null => {
  for (const h of CITY_HEADERS) {
    const v = header(h)?.trim();
    if (!v || v === "?") continue;
    try {
      return decodeURIComponent(v).slice(0, 80);
    } catch {
      return null;
    }
  }
  return null;
};

export const pairingNet = (
  ip: string,
  key: string,
  header: (name: string) => string | undefined = () => undefined,
): PairingNet | null => {
  const n = networkOf(ip);
  if (!n) return null;
  const netHash = createHmac("sha256", key).update(`chalito.pairing-net.v1:${n.family}:${n.net}`).digest("hex");
  return { family: n.family, netHash, city: cityOf(header) };
};

/** Same network, another one, or unknown (no record, not an address, or IPv4 against IPv6). */
export const compareNetworks = (asked: PairingNet | null, approving: PairingNet | null): PairingNetwork => {
  if (!asked || !approving || asked.family !== approving.family) return "unknown";
  return asked.netHash === approving.netHash ? "same" : "different";
};

/**
 * Owner decision #52 (2026-10-16): a public IP is not proof (CGNAT, offices, cafés). One tap only
 * for a browser proven to run on the computer itself, through the agent's loopback proof; anyone
 * else types the short code shown on the computer. The network comparison is warning text only.
 * "block" is kept for the alternative the owner considered (no approval without the proof).
 */
export type MismatchPolicy = "require_code" | "block";
export const DEFAULT_MISMATCH_POLICY: MismatchPolicy = "require_code";

/** The one place that decides what approving a pairing needs. */
export const pairingApproval = (
  s: { sameComputer: boolean },
  policy: MismatchPolicy = DEFAULT_MISMATCH_POLICY,
): PairingApproval => {
  if (s.sameComputer) return "one_tap";
  return policy === "block" ? "blocked" : "code_required";
};
