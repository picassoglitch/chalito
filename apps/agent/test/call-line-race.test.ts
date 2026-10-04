/**
 * Regression: an approval decided before the "requested" side effects finished used to leave
 * its plaintext call line behind (the line was removed first, then published by the still
 * running announce task). Seen over Supabase round-trips (agent-core.int.test.ts); reproduced
 * here with a slow call-line write and an immediate decision.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, fakeClaudeCode } from "@chalito/adapters/claude-code";
import { loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  sealJson,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import type { CallLine } from "@chalito/protocol";
import { AgentCore } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";

const OWNER = "hub-user-1";
const WS = "/home/aldo/code/chalito";

/** A store whose call-line inserts take a while (a network round-trip). */
class SlowCallLines extends MemoryStore {
  override async writeCallLine(id: string, line: CallLine) {
    await new Promise((r) => setTimeout(r, 60));
    await super.writeCallLine(id, line);
  }
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("approval call lines", () => {
  it("a decision that lands before the call line was published still leaves no call line", async () => {
    const agentSign = await generateSigningKeyPair();
    const agentBox = await generateBoxKeyPair();
    const phoneSign = await generateSigningKeyPair();
    const phoneBox = await generateBoxKeyPair();
    const agentId = "dev_agent";
    const phoneId = "dev_phone";
    const store = new SlowCallLines();
    const trust = new TrustedClientList(agentId);
    await trust.addConfirmed(
      { deviceId: phoneId, pubSign: await toB64url(phoneSign.publicKey), pubBox: await toB64url(phoneBox.publicKey) },
      Date.now(),
    );
    const policy: Policy = { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: WS }] };
    const fake = fakeClaudeCode([[{ tool: "Edit", input: { file_path: `${WS}/src/a.ts` } }]]);
    const core = new AgentCore({
      store,
      adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
      policy: { get: () => policy, set: async () => undefined },
      devMode: new DevMode({
        store: new DevModeStore(mkdtempSync(join(tmpdir(), "dm-")), agentSign, agentId),
        osAuth: { verify: async () => false },
        prompter: {
          first: async () => false,
          second: async () => false,
          liability: async () => ({ checked: false, typed: "" }),
        },
        liability: loadLiabilityText("es"),
        deviceId: agentId,
        now: Date.now,
        emit: async () => undefined,
      }),
      trust: () => trust,
      saveTrust: async () => undefined,
      nonces: new MemoryNonceStore(),
      owner: OWNER,
      self: { deviceId: agentId, pubBox: await toB64url(agentBox.publicKey), box: agentBox },
      home: "/home/aldo",
      locale: () => "es",
      now: Date.now,
      log: createLogger(() => undefined),
    });
    store.watchCommands((id, d) => void core.handleCommand(id, d));

    const cid = "cmd1";
    const env = await signEnvelope(
      "chalito.command.v1",
      {
        v: 1 as const,
        cid,
        uid: OWNER,
        targetDeviceId: agentId,
        origin: `client:${phoneId}`,
        nonce: await randomNonce(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        payload: {
          type: "session.start" as const,
          adapter: "claude-code" as const,
          workspaceLabel: "chalito",
          promptCt: await sealJson("arregla el login", { [agentId]: agentBox.publicKey }, `command:${cid}`),
          permissionMode: "default" as const,
        },
      },
      phoneId,
      phoneSign.secretKey,
    );
    store.sendCommand(cid, { env });

    // The phone decides the moment the approval exists (before the slow call line lands).
    await waitFor(() => store.pendingApprovals().length === 1);
    const a = store.pendingApprovals()[0]!;
    const decision = await signEnvelope(
      "chalito.decision.v1",
      {
        v: 1 as const,
        aid: a.aid,
        requestId: a.requestId,
        uid: OWNER,
        targetDeviceId: agentId,
        allow: true,
        nonce: await randomNonce(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      phoneId,
      phoneSign.secretKey,
    );
    store.attachDecision(a.aid, decision);
    await waitFor(() => fake.run.ran.length === 1);
    await new Promise((r) => setTimeout(r, 150)); // longer than the slow write
    expect([...store.callLines.keys()]).toEqual([]);
    for (const s of core.sessions.values()) s.handle.close();
  });
});
