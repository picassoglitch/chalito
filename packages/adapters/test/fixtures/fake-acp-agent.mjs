#!/usr/bin/env node
// A scripted ACP v1 agent for tests (JSON-RPC 2.0, ndjson on stdio), written against the
// protocol, not the SDK, so the adapter's wire format is checked independently.
// Reads its script from ./.fake-acp.json in its cwd and logs everything it receives (plus its
// argv and the environment variables tests care about) to ./.fake-acp.log.jsonl.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const script = JSON.parse(readFileSync(".fake-acp.json", "utf8"));
const log = (entry) => appendFileSync(".fake-acp.log.jsonl", `${JSON.stringify(entry)}\n`);
log({
  argv: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|NODE_|VITEST)/.test(k))),
});

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const notify = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });

let nextId = 1000;
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

let authenticated = false;
let turnIndex = 0;
let cancel = null;
let SID = script.sessionId ?? "fake-session-1";

const runTurn = async (steps) => {
  let cancelled = false;
  const cancelledP = new Promise((resolve) => {
    cancel = () => {
      cancelled = true;
      resolve();
    };
  });
  for (const step of steps) {
    if (cancelled) break;
    if (step.say) notify(SID, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
    if (step.mode) notify(SID, { sessionUpdate: "current_mode_update", currentModeId: step.mode });
    if (step.crash) process.exit(3);
    if (step.tool) {
      const tc = { toolCallId: step.tool.id, title: step.tool.title ?? step.tool.id, kind: step.tool.kind };
      if (step.tool.rawInput) tc.rawInput = step.tool.rawInput;
      if (step.tool.locations) tc.locations = step.tool.locations;
      notify(SID, { sessionUpdate: "tool_call", status: "pending", ...tc });
      let ok = true;
      if (step.tool.ask !== false) {
        const res = await request("session/request_permission", {
          sessionId: SID,
          toolCall: { toolCallId: step.tool.id },
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
            { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        log({ permission: step.tool.id, outcome: res.result?.outcome ?? null });
        ok = res.result?.outcome?.outcome === "selected" && res.result.outcome.optionId === "allow-once";
      }
      notify(SID, { sessionUpdate: "tool_call_update", toolCallId: step.tool.id, status: ok ? "completed" : "failed" });
    }
    if (step.waitCancel) await cancelledP;
  }
  cancel = null;
  if (cancelled) return { stopReason: "cancelled" };
  const usage = steps.find((s) => s.usage)?.usage;
  return { stopReason: "end_turn", ...(usage ? { usage } : {}) };
};

const handle = async (m) => {
  const { id, method, params } = m;
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: script.protocolVersion ?? 1,
          authMethods: script.authMethods ?? [],
          agentCapabilities: { loadSession: true, promptCapabilities: {} },
          agentInfo: { name: "fake-acp", version: "0.0.1" },
        },
      });
    case "authenticate":
      if (script.authFail) return send({ id, error: { code: -32000, message: script.authFail } });
      authenticated = true;
      return send({ id, result: {} });
    case "session/new":
    case "session/load": {
      if (script.requireAuth && !authenticated)
        return send({ id, error: { code: -32000, message: "Authentication required" } });
      if (method === "session/load") {
        SID = params.sessionId;
        notify(SID, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed history" },
        });
        return send({ id, result: {} });
      }
      send({ id, result: { sessionId: SID, ...(script.modes ? { modes: script.modes } : {}) } });
      if (script.commands)
        notify(SID, {
          sessionUpdate: "available_commands_update",
          availableCommands: script.commands.map((name) => ({ name, description: name })),
        });
      return;
    }
    case "session/set_mode":
      return send({ id, result: {} });
    case "session/prompt": {
      const steps = script.turns?.[turnIndex++] ?? [];
      const result = await runTurn(steps);
      return send({ id, result });
    }
    case "session/cancel":
      cancel?.();
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
};

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line);
    log({ in: m });
    if (m.method === undefined && m.id !== undefined) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      w?.(m);
      return;
    }
    void handle(m);
  })
  .on("close", () => process.exit(0));
