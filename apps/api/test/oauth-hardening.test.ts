/** Review fixes R-M3 (provider spoofing), R-M4 (CIMD SSRF), R-L10 (consent sign counter). */
import { describe, expect, it } from "vitest";
import { fetchCimd, providerOf } from "../src/oauth/clients.js";
import { UnsafeTarget, checkedLookup, publicAddress, safeFetch } from "../src/oauth/safe-fetch.js";
import { CLAUDE_CLIENT, CLAUDE_REDIRECT, RESOURCE, oauthHarness, pkce } from "./oauth-harness.js";

describe("R-M3: provider comes only from the provider's own CIMD origin", () => {
  it("Claude's and ChatGPT's CIMD documents", () => {
    expect(providerOf({ kind: "cimd", clientId: CLAUDE_CLIENT, redirectUris: [CLAUDE_REDIRECT] })).toBe("claude");
    expect(
      providerOf({
        kind: "cimd",
        clientId: "https://chatgpt.com/oauth/client.json",
        redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      }),
    ).toBe("chatgpt");
  });
  it.each([
    ["DCR with a claude.ai redirect", { kind: "dcr" as const, clientId: "dcr_x", redirectUris: [CLAUDE_REDIRECT] }],
    [
      "claude.ai redirect plus loopback",
      { kind: "cimd" as const, clientId: CLAUDE_CLIENT, redirectUris: [CLAUDE_REDIRECT, "http://127.0.0.1/cb"] },
    ],
    [
      "a foreign CIMD naming claude.ai redirects",
      { kind: "cimd" as const, clientId: "https://evil.example/c.json", redirectUris: [CLAUDE_REDIRECT] },
    ],
    [
      "a lookalike subdomain",
      { kind: "cimd" as const, clientId: "https://claude.ai.evil.example/c.json", redirectUris: [CLAUDE_REDIRECT] },
    ],
    [
      "a non-default port",
      { kind: "cimd" as const, clientId: "https://claude.ai:8443/c.json", redirectUris: [CLAUDE_REDIRECT] },
    ],
  ])("%s → other", (_name, client) => {
    expect(providerOf(client)).toBe("other");
  });

  it("a DCR client posing as Claude can't ask for session:prompt", async () => {
    const h = await oauthHarness();
    const reg = await h.call("/oauth/register", {
      json: { client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT, "http://127.0.0.1:3118/cb"] },
    });
    const p = pkce();
    const az = await h.call(
      `/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: reg.json.client_id as string,
        redirect_uri: "http://127.0.0.1:5000/cb",
        code_challenge: p.challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "mcp:read session:prompt",
      })}`,
    );
    expect(new URL(az.location!).searchParams.get("error")).toBe("invalid_scope");
  });
});

describe("R-M4: CIMD fetch can't reach internal addresses", () => {
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.4",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
  ])("%s is refused", (ip) => expect(publicAddress(ip)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("%s is allowed", (ip) =>
    expect(publicAddress(ip)).toBe(true),
  );

  it.each([
    "http://example.com/c.json",
    "https://127.0.0.1/c.json",
    "https://[::1]/c.json",
    "https://169.254.169.254/latest",
    "https://localhost/c.json",
    "https://metadata.google.internal/computeMetadata/v1",
  ])("safeFetch refuses %s before connecting", async (url) => {
    await expect(safeFetch(url)).rejects.toBeInstanceOf(UnsafeTarget);
  });

  it("a hostname that RESOLVES to an internal address is refused at connect time", async () => {
    const run = (addrs: { address: string; family: number }[]) =>
      new Promise<{ err: Error | null; address: string }>((resolve) =>
        checkedLookup((_h, _o, cb) => cb(null, addrs))("cimd.example", {}, (err, address) => resolve({ err, address })),
      );
    expect((await run([{ address: "10.1.2.3", family: 4 }])).err).toBeInstanceOf(UnsafeTarget);
    // One bad answer among good ones is enough to refuse (no DNS round-robin games).
    expect(
      (
        await run([
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ])
      ).err,
    ).toBeInstanceOf(UnsafeTarget);
    expect(await run([{ address: "93.184.216.34", family: 4 }])).toEqual({ err: null, address: "93.184.216.34" });
  });

  it("errors are generic (no status or size oracle) and the body is capped", async () => {
    const id = "https://cimd.example/c.json";
    const status = (async () => new Response("x", { status: 404 })) as typeof fetch;
    await expect(fetchCimd(id, status)).rejects.toThrow("client metadata could not be fetched");
    const huge = (async () => new Response("x".repeat(70 * 1024))) as typeof fetch;
    await expect(fetchCimd(id, huge)).rejects.toThrow("client metadata could not be fetched");
    const notJson = (async () => new Response("<html>")) as typeof fetch;
    await expect(fetchCimd(id, notJson)).rejects.toThrow("client metadata could not be fetched");
  });
});

describe("R-L10: OAuth consent checks the passkey sign counter", () => {
  it("an assertion whose counter didn't move forward is refused and audited", async () => {
    const h = await oauthHarness();
    const cred = (await h.deps.repo.getDeviceWebAuthn(h.o, h.phone.deviceId))!;
    await h.deps.repo.setDeviceWebAuthn(h.o, h.phone.deviceId, { ...cred, counter: 1_000_000 });
    const a = await h.authorize({});
    expect(a.ok).toMatchObject({ status: 403, json: { error: "authenticator_cloned" } });
    expect(h.audit.events.some((e) => e.action === "webauthn.clone_suspected")).toBe(true);
    expect(h.mcp.grants.size).toBe(0);
  });
});
