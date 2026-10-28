// ADR 0031 tests: a real AgentCore (real gate, approvals, sealing) with a scripted adapter, a phone
// that signs commands and decisions, and optional links between two such agents.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import type { AdapterEvent, SessionAdapter, SessionHandle, SessionStartOptions } from "@chalito/adapters";
import { SESSIONS_DEFAULTS, loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  randomNonce,
  sealJson,
  signEnvelope,
  stepUpChallenge,
  toB64url,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import type { DecisionBody, Origin } from "@chalito/protocol";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import { AgentCore, type PolicyHolder } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { LinkManager, MemoryLinkCloud, MemoryLinkStorage } from "../src/links/index.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";

export const OWNER = "hub-user-1";
// Every temp folder these tests make is removed when the importing file ends: hundreds per run filled /tmp.
const made: string[] = [];
export const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
// Real folders (realpath'd: macOS /var → /private/var), so path checks behave the same on every OS.
const ROOT = realpathSync(tempDir("chalito-rc-"));
export const HOME = join(ROOT, "home");
export const WS = join(HOME, "code", "chalito");
mkdirSync(WS, { recursive: true });

export const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

export interface Device {
  id: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
  pubSign: string;
  pubBox: string;
}
export const device = async (derived = false): Promise<Device> => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  const id = derived ? await deriveDeviceId(sign.publicKey) : `phone${Math.random().toString(36).slice(2, 10)}`;
  return { id, sign, box, pubSign: await toB64url(sign.publicKey), pubBox: await toB64url(box.publicKey) };
};

export interface Run {
  opts: SessionStartOptions;
  prompts: { text: string; origin: Origin }[];
  interrupts: number;
  emit: (e: AdapterEvent) => void;
}

/** Records sessions and prompts; a test drives events and tool calls through the real gate. */
export class FakeAdapter implements SessionAdapter {
  readonly kind = "claude-code" as const;
  readonly localMcp = true;
  readonly runs: Run[] = [];
  /** Runs inside `start`, before it returns: events the core sees before it knows the sid. */
  onStart?: (run: Run) => void;
  async start(opts: SessionStartOptions): Promise<SessionHandle> {
    const run: Run = {
      opts,
      prompts: opts.prompt ? [{ text: opts.prompt, origin: opts.origin }] : [],
      interrupts: 0,
      emit: (e) => opts.onEvent(e),
    };
    this.runs.push(run);
    this.onStart?.(run);
    return {
      prompt: (text, origin) => void run.prompts.push({ text, origin }),
      interrupt: async () => {
        run.interrupts++;
        opts.onEvent({ type: "state", state: "interrupted" });
      },
      setPermissionMode: async () => undefined,
      close: () => undefined,
      done: new Promise<void>(() => undefined),
    };
  }
  run(sid: string): Run {
    const r = this.runs.find((x) => x.opts.sid === sid);
    if (!r) throw new Error(`no run ${sid}`);
    return r;
  }
  /** A tool call in the run's current turn, through the real gate. */
  tool(sid: string, toolName: string, input: Record<string, unknown>) {
    const r = this.run(sid);
    const origin = r.prompts.at(-1)?.origin ?? r.opts.origin;
    return r.opts.gate({ sid, toolUseId: `t${Math.random()}`, toolName, input, origin }, new AbortController().signal);
  }
}

export const agentFor = async (
  o: {
    self?: Device;
    phone?: Device;
    passkey?: SoftAuthenticator;
    cloud?: MemoryLinkCloud;
    ws?: string;
    maxLive?: number;
  } = {},
) => {
  const self = o.self ?? (await device(true));
  const phone = o.phone ?? (await device());
  const passkey = o.passkey ?? new SoftAuthenticator({ origin: "https://chalito.chalyb.com" });
  const store = new MemoryStore();
  const trust = new TrustedClientList(self.id);
  const passkeyRef = { credentialId: passkey.credentialId, publicKey: passkey.publicKey, rpId: "chalito.chalyb.com" };
  await trust.addConfirmed(
    { deviceId: phone.id, pubSign: phone.pubSign, pubBox: phone.pubBox, webauthn: passkeyRef },
    Date.now(),
  );
  let policy: Policy = { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: o.ws ?? WS }] };
  const holder: PolicyHolder = { get: () => policy, set: async (p) => void (policy = p) };
  const liability = loadLiabilityText("es");
  const devMode = new DevMode({
    store: new DevModeStore(tempDir("chalito-rc-"), self.sign, self.id),
    osAuth: { verify: async () => true },
    prompter: {
      first: async () => true,
      second: async () => true,
      liability: async () => ({ checked: true, typed: liability.phrase }),
    },
    liability,
    deviceId: self.id,
    now: Date.now,
    emit: async () => undefined,
  });
  const cloud = o.cloud ?? new MemoryLinkCloud();
  const audits: { type: string; meta: Record<string, unknown> }[] = [];
  const links = new LinkManager({
    deviceId: self.id,
    owner: OWNER,
    sign: self.sign,
    box: self.box,
    pubBox: self.pubBox,
    storage: new MemoryLinkStorage(),
    cloud,
    policy: () => policy,
    audit: (type, meta) => void audits.push({ type, meta }),
    publishDeviceEvent: async (e) => store.publishDeviceEvent(e),
    now: Date.now,
    log: createLogger(() => undefined),
  });
  // The host the core gives its link manager, for tests that call it directly.
  let linkHost: Parameters<LinkManager["attach"]>[0] | null = null;
  const attach = links.attach.bind(links);
  links.attach = (h) => ((linkHost = h), attach(h));
  const adapter = new FakeAdapter();
  /** Timers the core and its parts set; a test fires them by hand. */
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const core = new AgentCore({
    store,
    adapters: { "claude-code": adapter },
    policy: holder,
    devMode,
    trust: () => trust,
    saveTrust: async () => undefined,
    nonces: new MemoryNonceStore(),
    owner: OWNER,
    self: { deviceId: self.id, pubBox: self.pubBox, box: self.box, sign: self.sign },
    home: HOME,
    locale: () => "es",
    now: Date.now,
    log: createLogger(() => undefined),
    links,
    ...(o.maxLive
      ? {
          sessionsConfig: {
            ...SESSIONS_DEFAULTS,
            session: { ...SESSIONS_DEFAULTS.session, maxLivePerDevice: o.maxLive },
          },
        }
      : {}),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear: () => void (t.cleared = true) };
    },
  });

  let n = 0;
  /** A command signed by the phone; a function payload gets a sealer for this command's content. */
  type Seal = (v: unknown) => Promise<unknown>;
  const command = async (payload: Record<string, unknown> | ((seal: Seal) => Promise<unknown>)) => {
    const cid = `c${++n}${Math.random().toString(36).slice(2, 8)}`;
    const seal = (v: unknown) => sealJson(v, { [self.id]: self.box.publicKey }, `command:${cid}`);
    const body: Record<string, unknown> = {
      v: 1,
      cid,
      uid: OWNER,
      targetDeviceId: self.id,
      origin: `client:${phone.id}`,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      payload: typeof payload === "function" ? await payload(seal) : payload,
    };
    const env = await signEnvelope("chalito.command.v1", body, phone.id, phone.sign.secretKey);
    return core.handleCommand(String(body.cid), { env, fromDeviceId: phone.id });
  };
  /** The phone's signed answer to the newest pending approval (with its passkey when `stepUp`). */
  /** The phone answers approval `aid` (default: the newest pending one). */
  const answer = async (allow: boolean, stepUp = false, aid?: string) => {
    const pending = aid ? store.approvals.get(aid)! : store.pendingApprovals().at(-1)!;
    const opened = await openJson<{ request: { body: { detailsHash: string } } }>(
      pending.detailsCt,
      phone.id,
      phone.box,
      `approval:${pending.aid}`,
    );
    const body: DecisionBody = {
      v: 1,
      aid: pending.aid,
      requestId: pending.requestId,
      uid: OWNER,
      targetDeviceId: self.id,
      allow,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      detailsHash: opened.request.body.detailsHash,
    };
    if (stepUp) {
      const assertion = await passkey.stepUp(passkeyRef.rpId)(await stepUpChallenge(body));
      body.stepUp = { method: "webauthn", at: Date.now(), assertion };
    }
    store.attachDecision(pending.aid, await signEnvelope("chalito.decision.v1", body, phone.id, phone.sign.secretKey));
  };
  return {
    self,
    phone,
    passkey,
    store,
    core,
    adapter,
    links,
    cloud,
    audits,
    timers,
    linkHost: () => linkHost!,
    command,
    answer,
    policy: holder,
    setPolicy: (p: Policy) => void (policy = p),
  };
};
