import type { AgentEvent } from "@chalito/protocol";
import type { Logger } from "../redact.js";
import type { LanCloud } from "./cloud.js";
import { startMdns, type Discovery } from "./mdns.js";
import { LanService, type CommandOutcome, type LanPolicy } from "./service.js";
import type { HandshakeContext } from "./handshake.js";

/**
 * The daemon's one call into the LAN path: null when the cloud backend has no LAN grant (then
 * nothing changes). The service itself stays off until local policy turns it on.
 */
export const lanPath = (o: {
  cloud: { lan?(): LanCloud };
  self: { deviceId: string; sign: HandshakeContext["sign"] };
  policy: () => LanPolicy | undefined;
  handleCommand(id: string, doc: Record<string, unknown>): Promise<CommandOutcome>;
  /** Live events another of the owner's agents copied over the link (already bound to it). */
  onPeerEvent?(fromDeviceId: string, e: AgentEvent): void;
  log: Logger;
  now: () => number;
  discovery?: () => Promise<Discovery>;
}): LanService | null => {
  const cloud = o.cloud.lan?.();
  if (!cloud) return null;
  return new LanService({
    self: o.self,
    cloud,
    discovery: o.discovery ?? (() => startMdns({ log: o.log })),
    policy: o.policy,
    handleCommand: o.handleCommand,
    ...(o.onPeerEvent ? { onPeerEvent: o.onPeerEvent } : {}),
    now: o.now,
    log: o.log,
  });
};

/**
 * What the daemon does with the live events other agents copy over the LAN today: nothing reads
 * them in-tree yet (the desktop panel will), so they're counted per peer and logged at most once
 * per `everyMs` (metadata only: the peer, how many, the last event's type). D-069 (5).
 */
export const peerEventLog = (log: Logger, now: () => number, everyMs = 5 * 60_000) => {
  const seen = new Map<string, { n: number; at: number }>();
  return (fromDeviceId: string, e: AgentEvent): void => {
    const s = seen.get(fromDeviceId) ?? { n: 0, at: -Infinity };
    s.n++;
    if (now() - s.at >= everyMs) {
      log.info("lan.peer_events", { peer: fromDeviceId, count: s.n, last: e.type });
      s.n = 0;
      s.at = now();
    }
    seen.set(fromDeviceId, s);
    if (seen.size > 64) seen.delete(seen.keys().next().value!);
  };
};
