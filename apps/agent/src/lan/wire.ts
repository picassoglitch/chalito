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
    now: o.now,
    log: o.log,
  });
};
