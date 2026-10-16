import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import {
  SERVICE,
  answersFor,
  decodePacket,
  encodePacket,
  serviceRecords,
  servicesFrom,
  startMdns,
  type DiscoveredService,
} from "../src/lan/mdns.js";

const id = "7k2qm9xd4tpaw3hc";

describe("mDNS records", () => {
  it("round-trips a response and reads the service back", () => {
    const pkt = encodePacket({
      id: 0,
      response: true,
      questions: [],
      answers: serviceRecords(id, 4242, ["192.168.1.20"]),
    });
    const back = decodePacket(pkt)!;
    expect(back.response).toBe(true);
    expect(servicesFrom(back)).toEqual({ found: [{ id, port: 4242, addresses: ["192.168.1.20"] }], gone: [] });
  });

  it("advertises only the opaque id: no hostname, device id or owner on the wire", () => {
    const pkt = encodePacket({ id: 0, response: true, questions: [], answers: serviceRecords(id, 4242, ["10.0.0.2"]) });
    const text = pkt.toString("latin1");
    expect(text).toContain(id);
    expect(text).not.toContain(hostname());
    expect(text).not.toMatch(/dev_|hub-user|chalito\.chalyb/);
    // TXT carries the version only.
    const txt = decodePacket(pkt)!.answers.find((r) => r.type === 16);
    expect(txt?.data).toEqual(["v=1"]);
  });

  it("an answer flooded with addresses keeps the first 4 distinct ones", () => {
    const many = ["10.0.0.1", "10.0.0.1", ...Array.from({ length: 30 }, (_, i) => `10.0.1.${i}`)];
    const pkt = encodePacket({ id: 0, response: true, questions: [], answers: serviceRecords(id, 4242, many) });
    expect(servicesFrom(decodePacket(pkt)!).found[0]!.addresses).toEqual([
      "10.0.0.1",
      "10.0.1.0",
      "10.0.1.1",
      "10.0.1.2",
    ]);
  });

  it("a goodbye (TTL 0) is reported as gone", () => {
    const pkt = encodePacket({ id: 0, response: true, questions: [], answers: serviceRecords(id, 1, ["10.0.0.2"], 0) });
    expect(servicesFrom(decodePacket(pkt)!)).toEqual({ found: [], gone: [id] });
  });

  it("answers a PTR query for _chalito._tcp, and nothing else", () => {
    const q = decodePacket(
      encodePacket({ id: 0, response: false, questions: [{ name: SERVICE, type: 12 }], answers: [] }),
    )!;
    expect(answersFor(q, id, 9, ["10.0.0.2"]).length).toBe(4);
    const other = decodePacket(
      encodePacket({ id: 0, response: false, questions: [{ name: "_http._tcp.local", type: 12 }], answers: [] }),
    )!;
    expect(answersFor(other, id, 9, ["10.0.0.2"])).toEqual([]);
  });

  it("ignores ids that aren't ours in shape and garbage packets", () => {
    const bad = encodePacket({
      id: 0,
      response: true,
      questions: [],
      answers: serviceRecords("Aldos-MacBook", 1, ["10.0.0.2"]),
    });
    expect(servicesFrom(decodePacket(bad)!).found).toEqual([]);
    expect(decodePacket(Buffer.from([1, 2, 3]))).toBeNull();
    // A compression-pointer loop.
    const loop = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1]);
    expect(decodePacket(loop)).toBeNull();
    // Truncated record data.
    const full = encodePacket({ id: 0, response: true, questions: [], answers: serviceRecords(id, 1, ["10.0.0.2"]) });
    expect(decodePacket(full.subarray(0, full.length - 3))).toBeNull();
  });
});

// Real multicast on this machine: opt-in (CI runners and sandboxes often block 5353).
describe.skipIf(process.env.CHALITO_MDNS_TEST !== "1")("mDNS on the loopback network", () => {
  it("two responders find each other", async () => {
    const a = await startMdns({ addresses: () => ["127.0.0.1"] });
    const b = await startMdns({ addresses: () => ["127.0.0.1"] });
    const seen: DiscoveredService[] = [];
    b.onFound((s) => seen.push(s));
    a.advertise(id, 4321);
    b.query();
    await new Promise((r) => setTimeout(r, 500));
    await a.close();
    await b.close();
    expect(seen.some((s) => s.id === id && s.port === 4321)).toBe(true);
  });
});
