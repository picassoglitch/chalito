/**
 * M16 D (ADR 0022 §4): the gateway's `list_agents` / `create_task`, and the A2A server.
 * - Deny-all by default: no LinkAuthorizer configured means no task is ever relayed.
 * - A scope is required: `link:handoff`, never pre-checked, and for the A2A server only that.
 * - The A2A server is off unless configured, serves only exposed agents, and speaks A2A 1.0 JSON-RPC
 *   to the official SDK client.
 * - `a2a:` never auto-approves: a relayed A2A task reaching the real AgentCore is refused while the
 *   origin is off (the default), and with it on, a HIGH action waits for a signed phone decision
 *   even with Developer mode autoApproveHigh on.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCard as SdkAgentCard, Role, TaskState, type Task } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { ClaudeCodeAdapter } from "@chalito/adapters/claude-code";
import { fakeClaudeCode, type FakeStep } from "@chalito/adapters/testing";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import { loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  toB64url,
} from "@chalito/crypto";
import {
  AgentCard,
  RelayedCommand,
  agentCardFromRecipe,
  type LinkAuthorizeRequest,
  type LinkAuthorizer,
  type Recipe,
} from "@chalito/protocol";
import { AgentCore } from "../../agent/src/agent-core.js";
import { BUILTIN_CATALOG } from "../../agent/src/apps/catalog.js";
import { DevMode, DevModeStore } from "../../agent/src/devmode.js";
import { DEFAULT_POLICY } from "../../agent/src/policy/index.js";
import { createLogger } from "../../agent/src/redact.js";
import { MemoryStore } from "../../agent/src/store.js";
import { A2A_RESOURCE, CHATGPT_CLIENT, RESOURCE } from "../../api/test/oauth-harness.js";
import { gatewayHarness } from "./harness.js";

const AGENT = "dev_agent";
const allowing = (over: Partial<{ confirm: boolean; ceiling: "default" | "plan" | "acceptEdits" }> = {}) => {
  const seen: LinkAuthorizeRequest[] = [];
  const a: LinkAuthorizer = {
    authorize: async (req) => {
      seen.push(req);
      return {
        ok: true,
        linkId: "lnk_testlink1",
        mode: "handoff",
        confirm: over.confirm ?? false,
        permissionCeiling: over.ceiling ?? "acceptEdits",
      };
    },
  };
  return { a, seen };
};

/** A harness with an agent device the api, gateway and A2A store know about. */
const setup = async (opts: { a2a?: boolean; linkAuthorizer?: LinkAuthorizer } = {}) => {
  const g = await gatewayHarness(opts);
  const box = await generateBoxKeyPair();
  g.data.agentBoxes[AGENT] = await toB64url(box.publicKey);
  g.data.agentList.push({
    appId: "claude-code",
    deviceId: AGENT,
    deviceName: "Desk",
    kind: "claude-sdk",
    state: "connected",
  });
  g.mcp.devices.add(`${g.o}/${AGENT}`);
  g.a2a.agents.add(`${g.o}/${AGENT}`);
  return { g, box };
};

const claudeCard = () => agentCardFromRecipe(BUILTIN_CATALOG.recipes.find((r) => r.id === "claude-code") as Recipe)!;

describe("MCP gateway: list_agents and create_task", () => {
  it("list_agents comes with mcp:read; create_task needs link:handoff, which is never pre-checked", async () => {
    const { g } = await setup();
    const c = await g.mcpClient((await g.connect(["mcp:read"])).access_token);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_agents");
    expect(names).not.toContain("create_task");
    expect(g.result(await c.callTool({ name: "list_agents", arguments: {} })).value).toEqual({
      agents: [{ appId: "claude-code", deviceId: AGENT, deviceName: "Desk", kind: "claude-sdk", state: "connected" }],
    });
    // On the consent screen, link:handoff is offered unticked.
    const q = new URLSearchParams({
      response_type: "code",
      client_id: CHATGPT_CLIENT,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp:read link:handoff",
    });
    const az = await g.call(`/oauth/authorize?${q}`);
    const shown = await g.call(`/oauth/requests/${new URL(az.location!).searchParams.get("request")}`, {
      headers: g.phoneAuth,
    });
    expect(shown.json.scopes).toContainEqual(expect.objectContaining({ scope: "link:handoff", defaultChecked: false }));
  });

  it("deny-all by default: create_task is refused and nothing is relayed", async () => {
    const { g } = await setup();
    const c = await g.mcpClient((await g.connect(["mcp:read", "link:handoff"])).access_token);
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("create_task");
    const r = g.result(
      await c.callTool({
        name: "create_task",
        arguments: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", prompt: "arregla el login" },
      }),
    );
    expect(r).toEqual({ isError: true, value: "Chalito refused: link_denied (no_link)" });
    expect(g.mcp.commands).toHaveLength(0);
    expect(g.audit.events.map((e) => e.action)).toContain("link.handoff_denied");
  });

  it("the api refuses a task without link:handoff, even if the gateway were bypassed", async () => {
    const { g } = await setup({ linkAuthorizer: allowing().a });
    const t = await g.connect(["mcp:read", "session:prompt"]);
    const direct = await g.call("/v1/gateway/link-tasks", {
      json: {
        cid: "lnk_aaaaaaaaaaaa",
        appId: "claude-code",
        deviceId: AGENT,
        workspaceLabel: "chalito",
        promptCt: { alg: "x", nonce: "n", ct: "c", keys: {} },
      },
      headers: { authorization: "Bearer gateway-service-token", "x-chalito-access-token": t.access_token },
    });
    expect(direct).toMatchObject({ status: 403, json: { error: "insufficient_scope" } });
    expect(g.mcp.commands).toHaveLength(0);
  });

  it("an allowing authorizer: one RelayedCommand, a session.start capped at the default mode, prompt sealed to the agent", async () => {
    const auth = allowing({ ceiling: "acceptEdits" });
    const { g, box } = await setup({ linkAuthorizer: auth.a });
    const c = await g.mcpClient((await g.connect(["link:handoff"], CHATGPT_CLIENT)).access_token);
    const r = g.result(
      await c.callTool({
        name: "create_task",
        arguments: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", prompt: "arregla el login" },
      }),
    );
    expect(r.value).toMatchObject({ sent: true, linkId: "lnk_testlink1" });
    expect(auth.seen).toEqual([
      {
        origin: "mcp:chatgpt",
        fromAgent: "mcp:chatgpt",
        toAgent: "claude-code",
        targetDeviceId: AGENT,
        cwd: "chalito",
        hop: 0,
        chain: ["mcp:chatgpt"],
      },
    ]);
    const q = g.mcp.commands[0]!;
    const env = RelayedCommand.parse(q.env);
    expect(env).toMatchObject({
      relayedBy: "mcp-gateway",
      body: {
        origin: "mcp:chatgpt",
        targetDeviceId: AGENT,
        payload: { type: "session.start", appId: "claude-code", workspaceLabel: "chalito", permissionMode: "default" },
      },
    });
    expect(JSON.stringify(q.env)).not.toContain("arregla");
    const p = env.body.payload as { promptCt: Parameters<typeof openJson>[0] };
    expect(await openJson<string>(p.promptCt, AGENT, box, `command:${q.id}`)).toBe("arregla el login");
  });

  it('"ask me each time": relayed marked for confirmation, AUTH_REQUIRED until the phone answers (get_task)', async () => {
    const { g } = await setup({ linkAuthorizer: allowing({ confirm: true }).a });
    const c = await g.mcpClient((await g.connect(["link:handoff"])).access_token);
    const r = g.result(
      await c.callTool({
        name: "create_task",
        arguments: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", prompt: "x" },
      }),
    );
    expect(r.value).toMatchObject({ sent: true, linkId: "lnk_testlink1", state: "TASK_STATE_AUTH_REQUIRED" });
    const cid = (r.value as { cid: string }).cid;
    // One command, marked: the device asks the owner (link_handoff) before it starts anything.
    expect(g.mcp.commands).toHaveLength(1);
    expect(RelayedCommand.parse(g.mcp.commands[0]!.env).body.payload).toMatchObject({
      type: "session.start",
      linkConfirm: { linkId: "lnk_testlink1" },
    });
    expect(g.audit.events.map((e) => e.action)).toContain("link.handoff_pending");
    const state = async () =>
      (
        g.result(await c.callTool({ name: "get_task", arguments: { deviceId: AGENT, cid } })).value as {
          state: string;
        }
      ).state;
    expect(await state()).toBe("TASK_STATE_AUTH_REQUIRED");
    const key = `${AGENT}/${cid}`;
    g.data.linkApprovals.set(key, { status: "pending", expiresAt: Date.now() + 600_000, resolvedAt: null });
    expect(await state()).toBe("TASK_STATE_AUTH_REQUIRED");
    // Approved: starting, then working once the session (named after the cid) exists.
    g.data.linkApprovals.set(key, { status: "approved", expiresAt: Date.now() + 600_000, resolvedAt: Date.now() });
    expect(await state()).toBe("TASK_STATE_SUBMITTED");
    g.data.sessions.set(cid, {
      sid: cid,
      deviceId: AGENT,
      deviceName: "Desk",
      adapter: "claude-code",
      state: "running",
      updatedAt: Date.now(),
    });
    expect(await state()).toBe("TASK_STATE_WORKING");
    g.data.sessions.delete(cid);
    // Declined, or no answer in time: rejected.
    g.data.linkApprovals.set(key, { status: "denied", expiresAt: Date.now() + 600_000, resolvedAt: Date.now() });
    expect(await state()).toBe("TASK_STATE_REJECTED");
    g.data.linkApprovals.set(key, { status: "expired", expiresAt: Date.now() - 1, resolvedAt: Date.now() });
    expect(await state()).toBe("TASK_STATE_REJECTED");
    g.data.linkApprovals.set(key, { status: "pending", expiresAt: Date.now() - 1, resolvedAt: null });
    expect(await state()).toBe("TASK_STATE_REJECTED");
  });

  it("get_task never reads another device's or owner's rows", async () => {
    const { g } = await setup({ linkAuthorizer: allowing({ confirm: true }).a });
    const c = await g.mcpClient((await g.connect(["link:handoff"])).access_token);
    const r = g.result(
      await c.callTool({
        name: "create_task",
        arguments: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", prompt: "x" },
      }),
    );
    const cid = (r.value as { cid: string }).cid;
    g.data.sessions.set(cid, {
      sid: cid,
      deviceId: "dev_other",
      deviceName: null,
      adapter: null,
      state: "running",
      updatedAt: null,
    });
    const got = g.result(await c.callTool({ name: "get_task", arguments: { deviceId: AGENT, cid } }));
    expect(got.value).toMatchObject({ state: "TASK_STATE_AUTH_REQUIRED" });
  });
});

/** The official SDK client, pointed at the gateway with a bearer token. */
const sdkClient = async (g: Awaited<ReturnType<typeof gatewayHarness>>, cardUrl: string, token?: string) => {
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return g.gwFetch(input instanceof Request ? input.url : input.toString(), { ...init, headers });
  }) as typeof fetch;
  const card = SdkAgentCard.fromJSON(await (await fetchImpl(cardUrl)).json());
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] }).createFromAgentCard(card);
};
const send = (text: string) => ({
  tenant: "",
  message: {
    messageId: "m1",
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      { content: { $case: "text" as const, value: text }, metadata: undefined, filename: "", mediaType: "text/plain" },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  },
  configuration: undefined,
  metadata: undefined,
});

describe("A2A server", () => {
  it("is off by default: no card, no endpoint, and the authorization server won't issue for it", async () => {
    const { g } = await setup();
    for (const [path, method] of [
      ["/a2a/a2x_0123456789abcdefghij/.well-known/agent-card.json", "GET"],
      ["/a2a/a2x_0123456789abcdefghij", "POST"],
      ["/.well-known/oauth-protected-resource/a2a", "GET"],
    ] as const)
      expect((await g.gwFetch(`https://mcp.chalito.test${path}`, { method })).status).toBe(404);
    const a = await g.authorize({ scopes: ["link:handoff"], resource: A2A_RESOURCE });
    expect(a.az.location).toContain("error=invalid_target");
    expect((await g.call("/v1/a2a/exposures", { headers: g.phoneAuth })).status).toBe(404);
  });

  it("serves an A2A 1.0 card only for an exposed agent, with Chalito's OAuth and a JSON-RPC interface", async () => {
    const { g } = await setup({ a2a: true });
    const made = await g.call("/v1/a2a/exposures", {
      json: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", card: claudeCard() },
      headers: g.phoneAuth,
    });
    expect(made.status).toBe(201);
    const id = made.json.exposureId as string;
    const res = await g.gwFetch(`${A2A_RESOURCE}/${id}/.well-known/agent-card.json`);
    const json = await res.json();
    expect(AgentCard.safeParse(json).success).toBe(true);
    expect(json).toMatchObject({
      name: "Claude Code",
      supportedInterfaces: [{ url: `${A2A_RESOURCE}/${id}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      securitySchemes: { chalito: { oauth2SecurityScheme: { flows: { authorizationCode: { pkceRequired: true } } } } },
      securityRequirements: [{ schemes: { chalito: { list: ["link:handoff"] } } }],
    });
    // Round-trips through the SDK's codec unchanged (ProtoJSON).
    expect(SdkAgentCard.toJSON(SdkAgentCard.fromJSON(json))).toEqual(json);
    expect((await g.gwFetch(`${A2A_RESOURCE}/a2x_notexposed000000000/.well-known/agent-card.json`)).status).toBe(404);
    await g.call(`/v1/a2a/exposures/${id}/revoke`, { method: "POST", headers: g.phoneAuth });
    expect((await g.gwFetch(`${A2A_RESOURCE}/${id}/.well-known/agent-card.json`)).status).toBe(404);
  });

  it("an A2A grant carries link:handoff only; tokens don't cross between the MCP gateway and the A2A server", async () => {
    const { g } = await setup({ a2a: true });
    const bad = await g.authorize({ scopes: ["mcp:read", "link:handoff"], resource: A2A_RESOURCE });
    expect(bad.az.location).toContain("error=invalid_scope");
    const a2aTok = await g.connect(["link:handoff"], undefined, A2A_RESOURCE);
    await expect(g.mcpClient(a2aTok.access_token)).rejects.toThrow();
    const mcpTok = await g.connect(["link:handoff"]);
    const made = await g.call("/v1/a2a/exposures", {
      json: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", card: claudeCard() },
      headers: g.phoneAuth,
    });
    const url = `${A2A_RESOURCE}/${made.json.exposureId}`;
    const rpc = (token?: string) =>
      g.gwFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} }),
      });
    const none = await rpc();
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("oauth-protected-resource/a2a");
    expect((await rpc(mcpTok.access_token)).status).toBe(401);
    expect(g.mcp.commands).toHaveLength(0);
  });

  it("deny-all by default: the SDK client's SendMessage comes back REJECTED, nothing is relayed", async () => {
    const { g } = await setup({ a2a: true });
    const made = await g.call("/v1/a2a/exposures", {
      json: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", card: claudeCard() },
      headers: g.phoneAuth,
    });
    const tok = await g.connect(["link:handoff"], undefined, A2A_RESOURCE);
    const client = await sdkClient(
      g,
      `${A2A_RESOURCE}/${made.json.exposureId}/.well-known/agent-card.json`,
      tok.access_token,
    );
    const r = (await client.sendMessage(send("arregla el login"))) as Task;
    expect(r.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(r.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Chalito refused the task (no_link).",
    });
    expect(g.mcp.commands).toHaveLength(0);
  });

  it("an allowing authorizer: SUBMITTED, relayed by a2a-server with origin a2a:<grant>; GetTask works for the same grant", async () => {
    const auth = allowing();
    const { g } = await setup({ a2a: true, linkAuthorizer: auth.a });
    const made = await g.call("/v1/a2a/exposures", {
      json: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", card: claudeCard() },
      headers: g.phoneAuth,
    });
    const tok = await g.connect(["link:handoff"], undefined, A2A_RESOURCE);
    const client = await sdkClient(
      g,
      `${A2A_RESOURCE}/${made.json.exposureId}/.well-known/agent-card.json`,
      tok.access_token,
    );
    const r = (await client.sendMessage(send("arregla el login"))) as Task;
    expect(r.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    const grant = (await g.mcp.listGrants(g.o)).find((x) => x.resource === A2A_RESOURCE)!;
    expect(auth.seen[0]).toMatchObject({
      origin: `a2a:${grant.cid}`,
      toAgent: "claude-code",
      targetDeviceId: AGENT,
      hop: 0,
    });
    const env = RelayedCommand.parse(g.mcp.commands[0]!.env);
    expect(env).toMatchObject({
      relayedBy: "a2a-server",
      body: {
        origin: `a2a:${grant.cid}`,
        payload: { type: "session.start", appId: "claude-code", permissionMode: "default" },
      },
    });
    expect((await client.getTask({ tenant: "", id: r.id })).id).toBe(r.id);
  });
});

describe('A2A server: a link set to "ask me each time"', () => {
  const confirmTask = async () => {
    const { g } = await setup({ a2a: true, linkAuthorizer: allowing({ confirm: true }).a });
    const made = await g.call("/v1/a2a/exposures", {
      json: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", card: claudeCard() },
      headers: g.phoneAuth,
    });
    const tok = await g.connect(["link:handoff"], undefined, A2A_RESOURCE);
    const client = await sdkClient(
      g,
      `${A2A_RESOURCE}/${made.json.exposureId}/.well-known/agent-card.json`,
      tok.access_token,
    );
    const r = (await client.sendMessage(send("arregla el login"))) as Task;
    const cid = g.mcp.commands[0]!.id;
    const get = async () => (await client.getTask({ tenant: "", id: r.id })).status?.state;
    return { g, r, cid, get };
  };

  it("SendMessage: AUTH_REQUIRED (not INPUT_REQUIRED), relayed marked for the phone's confirmation", async () => {
    const { g, r, get } = await confirmTask();
    expect(r.status?.state).toBe(TaskState.TASK_STATE_AUTH_REQUIRED);
    expect(r.status?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Waiting for the owner to confirm on their phone.",
    });
    expect(RelayedCommand.parse(g.mcp.commands[0]!.env)).toMatchObject({
      relayedBy: "a2a-server",
      body: { payload: { type: "session.start", linkConfirm: { linkId: "lnk_testlink1" } } },
    });
    expect(await get()).toBe(TaskState.TASK_STATE_AUTH_REQUIRED);
  });

  it("approve: GetTask shows WORKING once the device started the session", async () => {
    const { g, cid, get } = await confirmTask();
    g.data.linkApprovals.set(`${AGENT}/${cid}`, {
      status: "approved",
      expiresAt: Date.now() + 600_000,
      resolvedAt: Date.now(),
    });
    g.data.sessions.set(cid, {
      sid: cid,
      deviceId: AGENT,
      deviceName: "Desk",
      adapter: "claude-code",
      state: "running",
      updatedAt: Date.now(),
    });
    expect(await get()).toBe(TaskState.TASK_STATE_WORKING);
    // Settled: it stays WORKING here even if the rows change.
    g.data.sessions.delete(cid);
    expect(await get()).toBe(TaskState.TASK_STATE_WORKING);
  });

  it("deny: REJECTED", async () => {
    const { g, cid, get } = await confirmTask();
    g.data.linkApprovals.set(`${AGENT}/${cid}`, {
      status: "denied",
      expiresAt: Date.now() + 600_000,
      resolvedAt: Date.now(),
    });
    expect(await get()).toBe(TaskState.TASK_STATE_REJECTED);
  });

  it("expiry: REJECTED (TTL passed, or the device never picked the task up)", async () => {
    const { g, cid, get } = await confirmTask();
    g.data.linkApprovals.set(`${AGENT}/${cid}`, { status: "pending", expiresAt: Date.now() - 1, resolvedAt: null });
    expect(await get()).toBe(TaskState.TASK_STATE_REJECTED);
    const second = await confirmTask();
    second.g.skew(7 * 60_000);
    expect(await second.get()).toBe(TaskState.TASK_STATE_REJECTED);
  });
});

describe("a relayed A2A task on the real AgentCore", () => {
  const WS = "/home/aldo/code/chalito";
  const pushTurn: FakeStep[] = [{ tool: "Bash", input: { command: "git push origin fix-login" } }];
  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const core = async (owner: string, box: Awaited<ReturnType<typeof generateBoxKeyPair>>, a2aOn: boolean) => {
    const sign = await generateSigningKeyPair();
    const store = new MemoryStore();
    const liability = loadLiabilityText("es");
    const devMode = new DevMode({
      store: new DevModeStore(mkdtempSync(join(tmpdir(), "chalito-a2a-")), sign, AGENT),
      osAuth: { verify: async () => true },
      prompter: {
        first: async () => true,
        second: async () => true,
        liability: async () => ({ checked: true, typed: liability.phrase }),
      },
      liability,
      deviceId: AGENT,
      now: Date.now,
      emit: async () => undefined,
    });
    await devMode.enableToggle("autoApproveHigh");
    const fake = fakeClaudeCode([pushTurn]);
    // A trusted phone with a passkey: who an approval goes to.
    const trust = new TrustedClientList(AGENT);
    const phoneSign = await generateSigningKeyPair();
    const passkey = new SoftAuthenticator({ origin: "https://chalito.chalyb.com" });
    await trust.addConfirmed(
      {
        deviceId: "dev_phone",
        pubSign: await toB64url(phoneSign.publicKey),
        pubBox: await toB64url((await generateBoxKeyPair()).publicKey),
        webauthn: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, rpId: "chalito.chalyb.com" },
      },
      Date.now(),
    );
    const policy = {
      ...DEFAULT_POLICY,
      workspaces: [{ label: "chalito", path: WS }],
      origins: { ...DEFAULT_POLICY.origins, ...(a2aOn ? { a2a: true } : {}) },
    };
    const c = new AgentCore({
      store,
      adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
      policy: { get: () => policy, set: async () => undefined },
      devMode,
      trust: () => trust,
      saveTrust: async () => undefined,
      nonces: new MemoryNonceStore(),
      owner,
      self: { deviceId: AGENT, pubBox: await toB64url(box.publicKey), box, sign },
      home: "/home/aldo",
      locale: () => "es",
      now: Date.now,
      log: createLogger(() => undefined),
      setTimer: () => ({ clear: () => undefined }),
    });
    return { core: c, store, fake };
  };

  const relayed = async (box?: Awaited<ReturnType<typeof generateBoxKeyPair>>) => {
    const { g, box: b } = await setup({ a2a: true, linkAuthorizer: allowing().a });
    const made = await g.call("/v1/a2a/exposures", {
      json: { appId: "claude-code", deviceId: AGENT, workspaceLabel: "chalito", card: claudeCard() },
      headers: g.phoneAuth,
    });
    const tok = await g.connect(["link:handoff"], undefined, A2A_RESOURCE);
    const client = await sdkClient(
      g,
      `${A2A_RESOURCE}/${made.json.exposureId}/.well-known/agent-card.json`,
      tok.access_token,
    );
    await client.sendMessage(send("haz push"));
    return { g, box: box ?? b, q: g.mcp.commands[0]! };
  };

  it("is refused while the a2a: origin is off on the device (the default)", async () => {
    const { g, box, q } = await relayed();
    const a = await core(g.o, box, false);
    expect(await a.core.handleCommand(q.id, { env: q.env, fromDeviceId: "a2a-server" })).toEqual({
      ok: false,
      reason: "origin_disabled",
    });
    expect(a.fake.run.ran).toHaveLength(0);
  });

  it("with it on, a HIGH action still waits for a signed phone decision, even with autoApproveHigh", async () => {
    const { g, box, q } = await relayed();
    const a = await core(g.o, box, true);
    expect(await a.core.handleCommand(q.id, { env: q.env, fromDeviceId: "a2a-server" })).toEqual({
      ok: true,
      sid: expect.any(String),
    });
    await waitFor(() => a.store.pendingApprovals().length === 1);
    expect(a.store.pendingApprovals()[0]).toMatchObject({ risk: "HIGH", stepUpRequired: true });
    expect(a.store.pendingApprovals()[0]!.origin).toMatch(/^a2a:con_/);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.fake.run.ran).toHaveLength(0);
  });
});
