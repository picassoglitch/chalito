import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { wsSocketFactory } from "../src/voice/ws-socket.js";

describe("wsSocketFactory", () => {
  it("a refused handshake closes the socket instead of throwing an uncaught 'error'", async () => {
    // Answers the upgrade with a plain 403: `ws` emits 'error' then 'close'.
    const server = createServer((_req, res) => res.writeHead(403).end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const socket = wsSocketFactory(`ws://127.0.0.1:${port}/call`, { authorization: "Bearer x" });
      // Reaching 'close' means the 'error' was handled; unhandled, vitest fails the run.
      await expect(new Promise<void>((resolve) => socket.onClose(() => resolve()))).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });
});
