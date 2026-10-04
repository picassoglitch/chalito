/**
 * Building blocks the failure-path scenarios share with the main rehearsal's steps: a person with
 * a paired agent whose session is waiting on a HIGH approval (the approvals trigger has queued its
 * notification), push subscriptions written under RLS, and Claude connected over OAuth (CIMD).
 */
import { createHash, randomUUID } from "node:crypto";
import { ClaudeCodeAdapter } from "@chalito/adapters/claude-code";
import { fakeClaudeCode, type FakeStep } from "@chalito/adapters/testing";
import { TrustedClientList, randomNonce, sealJson, signEnvelope } from "@chalito/crypto";
import { CommandBody } from "@chalito/protocol";
import { pushSubscription } from "../../notifier/test/harness.js";
import { startAgent, waitFor } from "./agent.js";
import { MCP_RESOURCE, type Device, type Person, type Stack } from "./stack.js";

/** A device's web push subscription, as the PWA writes it (RLS: its own row). */
export const subscribePush = async (owner: string, d: Device) => {
  const sub = pushSubscription(`https://push.example.test/${randomUUID()}`);
  const { error } = await d.db.from("push_subscriptions").insert({
    owner,
    device_id: d.deviceId,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
  });
  if (error) throw new Error(`push subscription: ${error.message}`);
  return sub.endpoint;
};

export interface PendingHigh {
  agent: Awaited<ReturnType<typeof startAgent>>;
  agentDevice: Device;
  trust: TrustedClientList;
  fake: ReturnType<typeof fakeClaudeCode>;
  approval: { aid: string; request_id: string; details_ct: unknown };
  /** The notify_outbox row the approvals trigger queued for it. */
  notifyRow: { id: number; nid: string };
}

/**
 * The person's agent (paired, trusting the phone and its passkey) runs a session whose first tool
 * is HIGH; resolves once the approval is pending and its notification is queued.
 */
export const pendingHigh = async (s: Stack, p: Person, label: string): Promise<PendingHigh> => {
  const { device: agentDevice } = await s.pairAgent(p, label);
  const trust = new TrustedClientList(agentDevice.deviceId);
  await trust.addConfirmed(
    {
      deviceId: p.phone.deviceId,
      pubSign: p.phone.pubSign,
      pubBox: p.phone.pubBox,
      ...(p.credential ? { webauthn: p.credential } : {}),
    },
    Date.now(),
  );
  const push: FakeStep[] = [{ tool: "Bash", input: { command: "git push origin main" } }];
  const fake = fakeClaudeCode([push]);
  const agent = await startAgent({
    owner: p.owner,
    device: agentDevice,
    trust,
    adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
  });
  const cid = `cmd_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const start = await signEnvelope(
    "chalito.command.v1",
    CommandBody.parse({
      v: 1,
      cid,
      uid: p.owner,
      targetDeviceId: agentDevice.deviceId,
      origin: `client:${p.phone.deviceId}`,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      payload: {
        type: "session.start",
        adapter: "claude-code",
        workspaceLabel: "app",
        promptCt: await sealJson("publica", { [agentDevice.deviceId]: agentDevice.box.publicKey }, `command:${cid}`),
        permissionMode: "default",
      },
    }),
    p.phone.deviceId,
    p.phone.sign.secretKey,
  );
  const sent = await p.phone.db.from("commands").insert({
    owner: p.owner,
    target_device_id: agentDevice.deviceId,
    id: cid,
    env: start,
    from_device_id: p.phone.deviceId,
  });
  if (sent.error) throw new Error(`session.start: ${sent.error.message}`);
  let approval: PendingHigh["approval"] | null = null;
  await waitFor(
    async () => {
      const { data } = await p.phone.db
        .from("approvals")
        .select("aid, request_id, details_ct")
        .eq("owner", p.owner)
        .eq("status", "pending");
      approval = (data?.[0] as PendingHigh["approval"] | undefined) ?? null;
      return approval !== null;
    },
    20_000,
    "the HIGH approval",
  );
  const [row] = await s.sql<{ id: string; message: { item: { nid: string } } }[]>`
    select id, message from chalito_private.notify_outbox
    where owner = ${p.owner} and message ->> 'type' = 'notify' order by id desc limit 1`;
  if (!row) throw new Error("no notify row for the approval");
  return {
    agent,
    agentDevice,
    trust,
    fake,
    approval: approval!,
    notifyRow: { id: Number(row.id), nid: row.message.item.nid },
  };
};

export const CLAUDE_CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
/** Claude's client ID metadata document (what the api fetches for CIMD). */
export const claudeCimd = {
  client_id: CLAUDE_CLIENT,
  client_name: "Claude",
  redirect_uris: [CLAUDE_REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "none",
};

/**
 * Claude connects: authorize (CIMD client, PKCE), the person consents on the phone with the
 * passkey, the code is exchanged. The CIMD document must be served (msw) while this runs.
 */
export const connectClaude = async (s: Stack, p: Person, scopes: string[]) => {
  const verifier = randomUUID() + randomUUID();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const az = await s.api.request(
    `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: CLAUDE_CLIENT,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_RESOURCE,
      scope: scopes.join(" "),
      state: "st-1",
    })}`,
    { method: "GET" },
  );
  if (az.status !== 302) throw new Error(`authorize ${az.status}`);
  const requestId = new URL(az.headers.get("location")!).searchParams.get("request")!;
  const approved = await s.call(
    `/oauth/requests/${requestId}/approve`,
    { scopes, assertion: await s.stepUp(p) },
    p.phone.token,
  );
  if (approved.status !== 200) throw new Error(`consent ${approved.status}`);
  const code = new URL(approved.json.redirect).searchParams.get("code")!;
  const tok = await s.api.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLAUDE_CLIENT,
      redirect_uri: CLAUDE_REDIRECT,
      resource: MCP_RESOURCE,
    }).toString(),
  });
  if (tok.status !== 200) throw new Error(`token ${tok.status}`);
  return ((await tok.json()) as { access_token: string }).access_token;
};
