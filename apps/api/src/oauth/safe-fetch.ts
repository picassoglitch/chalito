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
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

export const publicAddress = (ip: string): boolean => {
  const v = isIP(ip);
  if (v === 0) return false;
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return publicAddress(mapped[1]!);
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
