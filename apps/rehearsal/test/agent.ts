/**
 * The real desktop agent for the rehearsal: AgentCore over SupabaseStore, signed in as its own
 * device user (the credential the api issued at pairing), with its own local trust list. Session
 * adapters are passed in by the steps that run a session (a scripted fake from
 * @chalito/adapters/testing, in tests only); the rest of the daemon is production code.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLiabilityText } from "@chalito/config";
import { MemoryNonceStore, type TrustedClientList } from "@chalito/crypto";
import { AgentCore } from "../../agent/src/agent-core.js";
import { DevMode, DevModeStore } from "../../agent/src/devmode.js";
import { DEFAULT_POLICY, type Policy } from "../../agent/src/policy/index.js";
import { createLogger } from "../../agent/src/redact.js";
import { SupabaseStore, type SupaClient } from "../../agent/src/supabase-store.js";
import type { Device } from "./stack.js";

export const WS = "/home/rehearsal/code/app";

export const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 20_000, what = "condition") => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

export const startAgent = async (o: {
  owner: string;
  device: Device;
  trust: TrustedClientList;
  adapters?: ConstructorParameters<typeof AgentCore>[0]["adapters"];
}) => {
  const policy: Policy = { ...DEFAULT_POLICY, workspaces: [{ label: "app", path: WS }] };
  const realtime: string[] = [];
  const log = createLogger((l) => {
    const j = JSON.parse(l) as { msg: string; status?: string };
    if (j.msg.startsWith("realtime.")) realtime.push(`${j.msg} ${j.status ?? ""}`.trim());
  });
  const store = new SupabaseStore(o.device.db as unknown as SupaClient, o.owner, o.device.deviceId, { log });
  const core = new AgentCore({
    store,
    adapters: o.adapters ?? {},
    policy: { get: () => policy, set: async () => undefined },
    devMode: new DevMode({
      store: new DevModeStore(mkdtempSync(join(tmpdir(), "rehearsal-dm-")), o.device.sign, o.device.deviceId),
      osAuth: { verify: async () => false },
      prompter: {
        first: async () => false,
        second: async () => false,
        liability: async () => ({ checked: false, typed: "" }),
      },
      liability: loadLiabilityText("es"),
      deviceId: o.device.deviceId,
      now: Date.now,
      emit: async () => undefined,
    }),
    trust: () => o.trust,
    saveTrust: async () => undefined,
    nonces: new MemoryNonceStore(),
    owner: o.owner,
    self: { deviceId: o.device.deviceId, pubBox: o.device.pubBox, box: o.device.box, sign: o.device.sign },
    home: "/home/rehearsal",
    locale: () => "es",
    now: Date.now,
    log: createLogger(() => undefined),
  } as ConstructorParameters<typeof AgentCore>[0]);
  const handled: { id: string; ok: boolean; reason?: string }[] = [];
  const stop = store.watchCommands(
    (id, d) =>
      void core
        .handleCommand(id, d)
        .then((r) => handled.push({ id, ok: r.ok, ...("reason" in r ? { reason: String(r.reason) } : {}) })),
  );
  await store.joined();
  await waitFor(() => realtime.some((l) => l.startsWith("realtime.subscribed")), 20_000, "the agent's channel");
  return {
    core,
    store,
    handled,
    close: async () => {
      stop();
      for (const s of core.sessions.values()) {
        s.handle.close();
        await s.handle.done.catch(() => undefined);
      }
      await store.close();
    },
  };
};
