import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

/**
 * Just enough multicast DNS (RFC 6762 / DNS-SD RFC 6763) for `_chalito._tcp`, without a
 * dependency. What the agent puts on the network is fixed here and nothing else:
 *
 *   PTR  _chalito._tcp.local          → <id>._chalito._tcp.local
 *   SRV  <id>._chalito._tcp.local     → <id>.local:<port>
 *   TXT  <id>._chalito._tcp.local     → "v=1"
 *   A    <id>.local                   → this computer's LAN IPv4 addresses
 *
 * `<id>` is the opaque rotating id (lanAdvertId): never the OS hostname, the device name, the
 * device id or the owner. Packets from other responders are parsed defensively (bounds-checked,
 * bounded compression pointers) and anything that isn't about `_chalito._tcp` is ignored.
 */

export const MDNS_ADDR = "224.0.0.251";
export const MDNS_PORT = 5353;
export const SERVICE = "_chalito._tcp.local";
const T_A = 1;
const T_PTR = 12;
const T_TXT = 16;
const T_SRV = 33;
const T_ANY = 255;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;
/** RFC 6762 §10: 120 s for records with a host name, 75 min otherwise; we keep both short. */
const TTL_HOST = 120;
const TTL_OTHER = 120;

export interface DnsQuestion {
  name: string;
  type: number;
}
export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  /** PTR target, SRV {port,target}, TXT strings, A address. */
  data: string | { port: number; target: string } | string[];
}
export interface DnsPacket {
  id: number;
  response: boolean;
  questions: DnsQuestion[];
  answers: DnsRecord[];
}

// ---------------------------------------------------------------- encoding

const encodeName = (name: string): Buffer => {
  const parts = name.split(".").filter(Boolean);
  const bufs: Buffer[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, "utf8");
    if (b.length > 63) throw new Error("mdns: label too long");
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
};

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff, 0);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};

const encodeRdata = (r: DnsRecord): Buffer => {
  switch (r.type) {
    case T_PTR:
      return encodeName(r.data as string);
    case T_SRV: {
      const d = r.data as { port: number; target: string };
      return Buffer.concat([u16(0), u16(0), u16(d.port), encodeName(d.target)]);
    }
    case T_TXT:
      return Buffer.concat(
        (r.data as string[]).flatMap((t) => {
          const b = Buffer.from(t, "utf8");
          return [Buffer.from([b.length]), b];
        }),
      );
    case T_A:
      return Buffer.from((r.data as string).split(".").map((x) => Number(x)));
    default:
      throw new Error("mdns: unsupported record");
  }
};

/** Unique records (everything but the shared PTR) carry the cache-flush bit. */
export const encodePacket = (p: DnsPacket): Buffer => {
  const parts: Buffer[] = [
    u16(p.id),
    u16(p.response ? 0x8400 : 0),
    u16(p.questions.length),
    u16(p.answers.length),
    u16(0),
    u16(0),
  ];
  for (const q of p.questions) parts.push(encodeName(q.name), u16(q.type), u16(CLASS_IN));
  for (const r of p.answers) {
    const rdata = encodeRdata(r);
    parts.push(
      encodeName(r.name),
      u16(r.type),
      u16(CLASS_IN | (r.type === T_PTR ? 0 : CACHE_FLUSH)),
      u32(r.ttl),
      u16(rdata.length),
      rdata,
    );
  }
  return Buffer.concat(parts);
};

// ---------------------------------------------------------------- decoding

class Malformed extends Error {}

const readName = (buf: Buffer, start: number): { name: string; next: number } => {
  const labels: string[] = [];
  let off = start;
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (off >= buf.length) throw new Malformed();
    const len = buf[off]!;
    if (len === 0) {
      off += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length || ++jumps > 16) throw new Malformed();
      if (next < 0) next = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1]!;
      continue;
    }
    if (len > 63 || off + 1 + len > buf.length) throw new Malformed();
    labels.push(buf.toString("utf8", off + 1, off + 1 + len));
    if (labels.length > 32) throw new Malformed();
    off += 1 + len;
  }
  return { name: labels.join("."), next: next < 0 ? off : next };
};

/** Returns null for anything malformed (other responders' packets are untrusted input). */
export const decodePacket = (buf: Buffer): DnsPacket | null => {
  try {
    if (buf.length < 12) return null;
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    if (qd > 64 || an > 128) return null;
    let off = 12;
    const questions: DnsQuestion[] = [];
    for (let i = 0; i < qd; i++) {
      const n = readName(buf, off);
      off = n.next;
      if (off + 4 > buf.length) return null;
      questions.push({ name: n.name.toLowerCase(), type: buf.readUInt16BE(off) });
      off += 4;
    }
    const answers: DnsRecord[] = [];
    for (let i = 0; i < an; i++) {
      const n = readName(buf, off);
      off = n.next;
      if (off + 10 > buf.length) return null;
      const type = buf.readUInt16BE(off);
      const ttl = buf.readUInt32BE(off + 4);
      const rdlen = buf.readUInt16BE(off + 8);
      off += 10;
      if (off + rdlen > buf.length) return null;
      const name = n.name.toLowerCase();
      if (type === T_PTR) answers.push({ name, type, ttl, data: readName(buf, off).name.toLowerCase() });
      else if (type === T_SRV && rdlen >= 7)
        answers.push({
          name,
          type,
          ttl,
          data: { port: buf.readUInt16BE(off + 4), target: readName(buf, off + 6).name.toLowerCase() },
        });
      else if (type === T_TXT) {
        const strings: string[] = [];
        let o = off;
        while (o < off + rdlen) {
          const l = buf[o]!;
          if (o + 1 + l > off + rdlen) return null;
          strings.push(buf.toString("utf8", o + 1, o + 1 + l));
          o += 1 + l;
        }
        answers.push({ name, type, ttl, data: strings });
      } else if (type === T_A && rdlen === 4)
        answers.push({ name, type, ttl, data: [...buf.subarray(off, off + 4)].join(".") });
      off += rdlen;
    }
    return { id, response: (flags & 0x8000) !== 0, questions, answers };
  } catch (err) {
    if (err instanceof Malformed || err instanceof RangeError) return null;
    throw err;
  }
};

// ---------------------------------------------------------------- service records

const instanceName = (id: string) => `${id}.${SERVICE}`;
const hostName = (id: string) => `${id}.local`;

/** The records for one advertisement (TTL 0 = goodbye). */
export const serviceRecords = (id: string, port: number, addresses: readonly string[], ttl?: number): DnsRecord[] => [
  { name: SERVICE, type: T_PTR, ttl: ttl ?? TTL_OTHER, data: instanceName(id) },
  { name: instanceName(id), type: T_SRV, ttl: ttl ?? TTL_HOST, data: { port, target: hostName(id) } },
  { name: instanceName(id), type: T_TXT, ttl: ttl ?? TTL_OTHER, data: ["v=1"] },
  ...addresses.map((a): DnsRecord => ({ name: hostName(id), type: T_A, ttl: ttl ?? TTL_HOST, data: a })),
];

/** What a query asks of our advertisement: the full set, or nothing. */
export const answersFor = (q: DnsPacket, id: string, port: number, addresses: readonly string[]): DnsRecord[] => {
  if (q.response) return [];
  const asks = q.questions.some(
    (x) =>
      (x.name === SERVICE && (x.type === T_PTR || x.type === T_ANY)) ||
      (x.name === instanceName(id) && (x.type === T_SRV || x.type === T_TXT || x.type === T_ANY)) ||
      (x.name === hostName(id) && (x.type === T_A || x.type === T_ANY)),
  );
  return asks ? serviceRecords(id, port, addresses) : [];
};

export interface DiscoveredService {
  /** The opaque advertised id (the first label of the instance name). */
  id: string;
  port: number;
  addresses: string[];
}

/**
 * Folds response records into services. A goodbye (TTL 0) is reported with no addresses. Only
 * `_chalito._tcp` instances whose id is a 16-character Crockford string are considered.
 */
export const servicesFrom = (p: DnsPacket): { found: DiscoveredService[]; gone: string[] } => {
  if (!p.response) return { found: [], gone: [] };
  const ids = new Map<string, boolean>();
  for (const r of p.answers)
    if (r.type === T_PTR && r.name === SERVICE && typeof r.data === "string" && r.data.endsWith(`.${SERVICE}`)) {
      const id = r.data.slice(0, -SERVICE.length - 1);
      if (/^[0-9a-hjkmnp-tv-z]{16}$/.test(id)) ids.set(id, r.ttl === 0);
    }
  const found: DiscoveredService[] = [];
  const gone: string[] = [];
  for (const [id, bye] of ids) {
    if (bye) {
      gone.push(id);
      continue;
    }
    const srv = p.answers.find((r) => r.type === T_SRV && r.name === instanceName(id));
    if (!srv || typeof srv.data !== "object" || Array.isArray(srv.data)) continue;
    const target = srv.data.target;
    const addresses = p.answers
      .filter((r) => r.type === T_A && r.name === target && typeof r.data === "string")
      .map((r) => r.data as string);
    if (addresses.length) found.push({ id, port: srv.data.port, addresses });
  }
  return { found, gone };
};

/** Non-internal IPv4 addresses of this computer (what goes in A records). */
export const lanAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);

// ---------------------------------------------------------------- discovery

/** How the LAN service finds and announces agents. mDNS in production; in memory in tests. */
export interface Discovery {
  /** Replaces the current advertisement (the previous id gets a goodbye). */
  advertise(id: string, port: number): void;
  /** Stops advertising (goodbye). */
  withdraw(): void;
  onFound(cb: (s: DiscoveredService) => void): void;
  onGone(cb: (id: string) => void): void;
  /** Asks the network who's there (answers arrive through onFound). */
  query(): void;
  close(): Promise<void>;
}

export interface MdnsOptions {
  /** Defaults to lanAddresses(); tests pass 127.0.0.1. */
  addresses?: () => string[];
  /** Interface to join and send on (default: the OS's choice). */
  iface?: string;
  log?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

/** mDNS over UDP 5353 (shared with the OS responder: SO_REUSEADDR). */
export const startMdns = async (o: MdnsOptions = {}): Promise<Discovery> => {
  const addresses = o.addresses ?? lanAddresses;
  const sock: Socket = createSocket({ type: "udp4", reuseAddr: true });
  const found: ((s: DiscoveredService) => void)[] = [];
  const gone: ((id: string) => void)[] = [];
  let ad: { id: string; port: number } | null = null;
  const send = (p: DnsPacket) => {
    const buf = encodePacket(p);
    sock.send(buf, 0, buf.length, MDNS_PORT, MDNS_ADDR, (err) => {
      if (err) o.log?.warn("lan.mdns_send_failed", { error: err.message });
    });
  };
  const announce = (id: string, port: number, ttl?: number) =>
    send({ id: 0, response: true, questions: [], answers: serviceRecords(id, port, addresses(), ttl) });

  sock.on("message", (msg) => {
    if (msg.length > 9000) return;
    const p = decodePacket(msg);
    if (!p) return;
    if (!p.response) {
      if (!ad) return;
      const answers = answersFor(p, ad.id, ad.port, addresses());
      if (answers.length) send({ id: 0, response: true, questions: [], answers });
      return;
    }
    const r = servicesFrom(p);
    for (const s of r.found) if (s.id !== ad?.id) for (const cb of found) cb(s);
    for (const id of r.gone) for (const cb of gone) cb(id);
  });
  sock.on("error", (err) => o.log?.warn("lan.mdns_error", { error: err.message }));
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(MDNS_PORT, () => {
      sock.removeListener("error", reject);
      try {
        sock.addMembership(MDNS_ADDR, o.iface);
        sock.setMulticastTTL(255);
        sock.setMulticastLoopback(true); // two agents on one computer (and the tests) see each other
        if (o.iface) sock.setMulticastInterface(o.iface);
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error("mdns: join failed"));
      }
    });
  });

  return {
    advertise: (id, port) => {
      if (ad && (ad.id !== id || ad.port !== port)) announce(ad.id, ad.port, 0);
      ad = { id, port };
      announce(id, port);
    },
    withdraw: () => {
      if (ad) announce(ad.id, ad.port, 0);
      ad = null;
    },
    onFound: (cb) => void found.push(cb),
    onGone: (cb) => void gone.push(cb),
    query: () => send({ id: 0, response: false, questions: [{ name: SERVICE, type: T_PTR }], answers: [] }),
    close: async () => {
      if (ad) announce(ad.id, ad.port, 0);
      ad = null;
      await new Promise<void>((r) => setTimeout(r, 20)); // let the goodbye leave
      await new Promise<void>((r) => sock.close(() => r()));
    },
  };
};

/** In-process discovery for tests: every member sees every other member's advertisement. */
export class MemoryDiscoveryHub {
  readonly #members = new Set<MemoryDiscovery>();
  join(addresses: string[] = ["127.0.0.1"]): MemoryDiscovery {
    const d = new MemoryDiscovery(this, addresses);
    this.#members.add(d);
    return d;
  }
  /** @internal */ leave(d: MemoryDiscovery) {
    this.#members.delete(d);
  }
  /** @internal */ broadcast(from: MemoryDiscovery, fn: (d: MemoryDiscovery) => void) {
    for (const m of this.#members) if (m !== from) fn(m);
  }
  /** @internal */ members() {
    return [...this.#members];
  }
}

export class MemoryDiscovery implements Discovery {
  ad: { id: string; port: number } | null = null;
  #found: ((s: DiscoveredService) => void)[] = [];
  #gone: ((id: string) => void)[] = [];
  constructor(
    private readonly hub: MemoryDiscoveryHub,
    private readonly addresses: string[],
  ) {}
  advertise(id: string, port: number) {
    if (this.ad && this.ad.id !== id) {
      const old = this.ad.id;
      this.hub.broadcast(this, (m) => m.emitGone(old));
    }
    this.ad = { id, port };
    this.hub.broadcast(this, (m) => m.emitFound({ id, port, addresses: this.addresses }));
  }
  withdraw() {
    if (!this.ad) return;
    const old = this.ad.id;
    this.ad = null;
    this.hub.broadcast(this, (m) => m.emitGone(old));
  }
  onFound(cb: (s: DiscoveredService) => void) {
    this.#found.push(cb);
  }
  onGone(cb: (id: string) => void) {
    this.#gone.push(cb);
  }
  query() {
    for (const m of this.hub.members())
      if (m !== this && m.ad) this.emitFound({ id: m.ad.id, port: m.ad.port, addresses: m.addresses });
  }
  async close() {
    this.withdraw();
    this.hub.leave(this);
  }
  /** @internal */ emitFound(s: DiscoveredService) {
    for (const cb of this.#found) cb(s);
  }
  /** @internal */ emitGone(id: string) {
    for (const cb of this.#gone) cb(id);
  }
}
