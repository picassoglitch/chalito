import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Registry data is untrusted: a listed server must not point Chalito at this computer or its network (SSRF).
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

/** True for loopback, private, link-local, CGNAT, ULA, metadata, multicast and reserved addresses. */
export const isPrivateAddress = (address: string): boolean => {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) return PRIVATE.check(ip, "ipv4");
  if (family !== 6) return true; // not an address: refuse
  // IPv4-mapped / -compatible IPv6 (::ffff:7f00:1) is checked as the IPv4 it carries.
  const mapped = /^::(?:ffff:)?(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mapped) {
    const n = (parseInt(mapped[1]!, 16) << 16) | parseInt(mapped[2]!, 16);
    return PRIVATE.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."), "ipv4");
  }
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) return PRIVATE.check(dotted[1]!, "ipv4");
  return PRIVATE.check(ip, "ipv6");
};

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/i;

/** A registry server's host: a public DNS name only (no IP literals, no local names, no single labels). */
export const isPublicHostname = (hostname: string): boolean => {
  const h = hostname.replace(/\.$/, "");
  if (!h || h.startsWith("[") || isIP(h)) return false;
  if (!h.includes(".") || LOCAL_NAMES.test(h)) return false;
  return /^[a-z0-9.-]+$/i.test(h);
};

/** A DNS lookup that refuses private answers, so the check holds at connect time (no rebinding). */
export const publicOnlyLookup =
  (lookup: typeof dnsLookup = dnsLookup): LookupFunction =>
  (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[] | string) => {
      if (err) return callback(err, "", 0);
      const list = Array.isArray(addresses) ? addresses : [];
      const bad = list.length === 0 || list.some((a) => isPrivateAddress(a.address));
      if (bad) {
        const e = Object.assign(new Error(`refused private address for ${hostname}`), { code: "EPRIVATE" });
        return callback(e, "", 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };

export type ProbeResult = "open" | "oauth" | "unreachable";

// MCP authorization answers 401 when a server wants OAuth. Only probed on a deliberate install,
// so searching never contacts unknown servers.
export const probeRemoteAuth = (
  url: string,
  o: { publicOnly: boolean; timeoutMs?: number; lookup?: typeof dnsLookup },
): Promise<ProbeResult> =>
  new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve("unreachable");
    }
    if (o.publicOnly && (u.protocol !== "https:" || !isPublicHostname(u.hostname))) return resolve("unreachable");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chalito", version: "1" } },
    });
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      u,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
        },
        timeout: o.timeoutMs ?? 10_000,
        ...(o.publicOnly ? { lookup: publicOnlyLookup(o.lookup) } : {}),
      },
      (res) => {
        res.resume();
        const s = res.statusCode ?? 0;
        // A redirect is not followed: it could lead anywhere.
        resolve(s === 401 ? "oauth" : s >= 200 && s < 300 ? "open" : s >= 400 && s < 500 ? "open" : "unreachable");
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve("unreachable"));
    req.end(body);
  });
