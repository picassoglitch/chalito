import WebSocket from "ws";
import type { CallSocketFactory } from "./call-agent.js";

/** Production CallSocket over `ws` (it sends the Authorization header the call socket needs). */
export const wsSocketFactory: CallSocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers });
  // `ws` emits 'error' on a failed handshake or a broken socket; with no listener that's an
  // uncaught exception and the whole notifier (every other call) goes down. 'close' always follows,
  // which is where the call agent cleans up.
  ws.on("error", () => undefined);
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onOpen: (cb) => void ws.on("open", cb),
    onMessage: (cb) => void ws.on("message", (d) => cb(d.toString())),
    onClose: (cb) => void ws.on("close", cb),
  };
};
