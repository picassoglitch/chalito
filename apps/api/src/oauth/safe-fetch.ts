import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Outbound fetch for client metadata documents (CIMD), which are user-supplied URLs (review
 * R-M4): https only, no redirects, a 5 s deadline, a 64 KB cap, and every address checked AT
 * CONNECT TIME (the agent's DNS lookup hook), so a DNS answer can't swap in an internal address
 * after a check. Private, loopback, link-local (incl. cloud metadata), CGNAT, unique-local,
 * multicast and reserved ranges are refused, IPv4-mapped IPv6 included.
 */
const blocked = new BlockList();
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
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  // 6to4 and Teredo embed an IPv4 address that a relay may reach on our behalf.
  ["2002::", 16],
  ["2001::", 32],
  // Deprecated site-local.
  ["fec0::", 10],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

/** The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 becomes two groups). */
const groups6 = (ip: string): number[] => {
  let a = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const [w, x, y, z] = v4[1]!.split(".").map(Number) as [number, number, number, number];
    a = `${a.slice(0, -v4[1]!.length)}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
  }
  const [head, tail] = a.includes("::") ? (a.split("::") as [string, string]) : [a, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const mid = tail === null ? [] : Array<string>(8 - h.length - t.length).fill("0");
  return [...h, ...mid, ...t].map((g) => parseInt(g, 16));
};

export const publicAddress = (ip: string): boolean => {
  const v = isIP(ip);
  if (v === 0) return false;
  if (v === 6) {
    const g = groups6(ip);
    // IPv4 embedded in IPv6: mapped ::ffff:a.b.c.d, SIIT ::ffff:0:a.b.c.d and the deprecated
    // IPv4-compatible ::a.b.c.d (e.g. ::7f00:1) are judged by their IPv4 address.
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
    const embedded =
      (zeros(5) && g[5] === 0xffff) || (zeros(4) && g[4] === 0xffff && g[5] === 0) || (zeros(6) && (g[6]! | g[7]!) > 1);
    if (embedded) return publicAddress(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
    return !blocked.check(ip, "ipv6");
  }
  return !blocked.check(ip, "ipv4");
};

export class UnsafeTarget extends Error {}

type LookupCb = (err: Error | null, address: string, family: number) => void;
type Resolver = (
  hostname: string,
  options: { all: true },
  cb: (err: Error | null, addrs: { address: string; family: number }[]) => void,
) => void;

/** The connect-time DNS hook: every resolved address must be public, or the connection fails. */
export const checkedLookup =
  (resolve: Resolver = lookup as unknown as Resolver) =>
  (hostname: string, options: object, cb: LookupCb): void => {
    resolve(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err, "", 4);
      if (addrs.length === 0 || !addrs.every((a) => publicAddress(a.address)))
        return cb(new UnsafeTarget("refused address"), "", 4);
      cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  };

const agent = new Agent({
  connect: { timeout: 5_000, lookup: checkedLookup() as never },
  headersTimeout: 5_000,
  bodyTimeout: 5_000,
  maxResponseSize: 64 * 1024,
});

/** A `fetch` for untrusted https URLs (shape-compatible with the global one). */
export const safeFetch = (async (input: URL | string, init?: RequestInit) => {
  const url = new URL(input.toString());
  if (url.protocol !== "https:") throw new UnsafeTarget("https only");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicAddress(host)) throw new UnsafeTarget("refused address");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    throw new UnsafeTarget("refused host");
  return undiciFetch(url, {
    ...(init as object),
    redirect: "error",
    dispatcher: agent,
    signal: AbortSignal.timeout(5_000),
  }) as unknown as Response;
}) as typeof fetch;
