import { describe, expect, it } from "vitest";
import { IpcUnavailableError, invokeIpc } from "../src/lib/ipc.js";

describe("the panel's calls to the local agent (agent_ipc)", () => {
  it("every AgentIpc method is one agent_ipc call with its params", async () => {
    const calls: unknown[] = [];
    const ipc = invokeIpc(async <T>(cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      return null as T;
    });
    await ipc.ping();
    await ipc.confirmPairing("p1", false);
    await ipc.devModeChallenge("allowSudo");
    await ipc.enableDevToggle("allowSudo", { first: true, second: true, liability: { checked: true, typed: "X" } });
    await ipc.disableDevToggle("bypassStyle");
    await ipc.reportPresence({ desktopActive: true });
    expect(calls).toEqual([
      ["agent_ipc", { method: "ping", params: null }],
      ["agent_ipc", { method: "confirmPairing", params: { pairingId: "p1", match: false } }],
      ["agent_ipc", { method: "devModeChallenge", params: { toggle: "allowSudo" } }],
      [
        "agent_ipc",
        {
          method: "enableDevToggle",
          params: {
            toggle: "allowSudo",
            answers: { first: true, second: true, liability: { checked: true, typed: "X" } },
          },
        },
      ],
      ["agent_ipc", { method: "disableDevToggle", params: { toggle: "bypassStyle" } }],
      ["agent_ipc", { method: "reportPresence", params: { desktopActive: true } }],
    ]);
  });

  it("no agent is IpcUnavailableError (the screens say so); other codes stay errors", async () => {
    const failing = (code: string) =>
      invokeIpc(async () => {
        throw code;
      });
    await expect(failing("agent_ipc_unavailable").ping()).rejects.toBeInstanceOf(IpcUnavailableError);
    await expect(failing("no_pending_pairing").confirmPairing("p", true)).rejects.toThrow("no_pending_pairing");
  });
});
