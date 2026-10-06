import { describe, expect, it } from "vitest";
import { CommandPayload, Provider, ProviderConnectionDoc, ProviderState } from "../src/index.js";

const b64 = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3));
const sealed = { alg: "xchacha20poly1305+sealedbox", nonce: b64(24), ct: b64(10), keys: { d1: b64(80) } };
const ok = (p: unknown) => CommandPayload.safeParse(p).success;

describe("provider.* commands", () => {
  it("covers exactly the four providers", () => {
    expect(Provider.options).toEqual(["anthropic", "openai", "xai", "google"]);
    expect(ok({ type: "provider.status" })).toBe(true);
    for (const provider of Provider.options) {
      expect(ok({ type: "provider.disconnect", provider })).toBe(true);
      expect(ok({ type: "provider.install", provider })).toBe(true);
    }
    expect(ok({ type: "provider.install", provider: "mistral" })).toBe(false);
  });

  it("an API key only travels sealed, and only with method api_key", () => {
    expect(ok({ type: "provider.connect", provider: "openai", method: "api_key", keyCt: sealed })).toBe(true);
    expect(ok({ type: "provider.connect", provider: "openai", method: "api_key" })).toBe(false);
    expect(ok({ type: "provider.connect", provider: "openai", method: "api_key", key: "sk-plain" })).toBe(false);
    expect(ok({ type: "provider.connect", provider: "openai", method: "api_key", keyCt: "sk-plain" })).toBe(false);
    expect(ok({ type: "provider.connect", provider: "xai", method: "signin" })).toBe(true);
    expect(ok({ type: "provider.connect", provider: "xai", method: "signin", keyCt: sealed })).toBe(false);
    expect(ok({ type: "provider.connect", provider: "xai", method: "oauth" })).toBe(false);
  });

  it("nothing in the provider surface can enable computer control or touch policy", () => {
    for (const type of ["provider.enableComputerControl", "computer.enable", "provider.setPolicy"]) {
      expect(ok({ type, provider: "anthropic" })).toBe(false);
    }
  });
});

describe("chalito.connections status doc", () => {
  const doc = {
    mode: "signin",
    connected: true,
    state: "connected",
    cli: { installed: true, version: "0.160.1" },
    error: null,
    at: 1_790_000_000_000,
  };

  it("parses the contract shape", () => {
    expect(ProviderConnectionDoc.safeParse(doc).success).toBe(true);
    expect(
      ProviderConnectionDoc.safeParse({
        ...doc,
        mode: null,
        connected: false,
        state: "not_installed",
        cli: { installed: false, version: null },
      }).success,
    ).toBe(true);
    expect(ProviderState.options).toContain("blocked_by_policy");
  });

  it("is status only: no extra fields, no free-text errors, connected matches state", () => {
    expect(ProviderConnectionDoc.safeParse({ ...doc, key: "sk-x" }).success).toBe(false);
    expect(ProviderConnectionDoc.safeParse({ ...doc, cli: { ...doc.cli, path: "/usr/bin/codex" } }).success).toBe(
      false,
    );
    expect(ProviderConnectionDoc.safeParse({ ...doc, error: "EACCES /home/me/.npm" }).success).toBe(false);
    expect(ProviderConnectionDoc.safeParse({ ...doc, state: "needs_auth" }).success).toBe(false);
  });
});
