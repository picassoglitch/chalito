import WebSocket from "ws";
import type { CallSocketFactory } from "./call-agent.js";

/** Production CallSocket over `ws` (it sends the Authorization header the call socket needs). */
export const wsSocketFactory: CallSocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers });
  return {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onOpen: (cb) => void ws.on("open", cb),
    onMessage: (cb) => void ws.on("message", (d) => cb(d.toString())),
    onClose: (cb) => void ws.on("close", cb),
  };
};
