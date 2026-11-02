import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_KEYS } from "../src/apps/catalog-keys.js";
import { readConfigFile } from "@chalito/config";
import {
  ConnectorCatalog,
  signConnectorCatalog,
  verifyConnectorCatalog,
  VerifiedConnectors,
} from "../src/connections/catalog.js";
import { shippedConnectors as loadBuiltinConnectors } from "../src/connections/shipped.js";
import { EMBEDDED_CONFIG } from "../scripts/embedded-config.js";

const devKey = JSON.parse(
  readFileSync(new URL("../../../recipes/test-fixtures/dev-catalog-key.json", import.meta.url), "utf8"),
) as { keyId: string; publicKey: string; secretKey: string };
const DEV_KEYS = { [devKey.keyId]: devKey.publicKey };
const signedFixture = () =>
  JSON.parse(readFileSync(new URL("./fixtures/connectors.dev.signed.json", import.meta.url), "utf8")) as {
    body: { issuedAt: number; connectors: { id: string; name: string }[] };
    sig: string;
    keyId: string;
  };

describe("connectors.yaml (the verified list)", () => {
  const builtin = loadBuiltinConnectors();

  it("parses, travels inside the compiled agent, and the dev key is never trusted", () => {
    expect(builtin.connectors.length).toBeGreaterThan(0);
    expect(EMBEDDED_CONFIG).toContain("connectors.yaml");
    expect(Object.keys(CATALOG_KEYS)).not.toContain(devKey.keyId);
    expect(Object.values(CATALOG_KEYS)).not.toContain(devKey.publicKey);
  });

  it("has the ADR 0023 §1a launch vendors, and every OAuth one is held (owner, 2026-11-01)", () => {
    const ids = builtin.connectors.map((c) => c.id);
    for (const id of ["github", "supabase", "linear", "slack", "gdrive"]) expect(ids).toContain(id);
    for (const c of builtin.connectors) {
      if (c.auth === "oauth") expect(c.held).toBe("oauth");
      if (!c.held) {
        expect(c.transport === "remote" ? "url" in c.server && c.server.url?.startsWith("https://") : true).toBe(true);
        // Token connectors say where the token goes.
        if (c.auth === "token") expect(c.inputs.some((i) => i.secret && i.required)).toBe(true);
      }
    }
    expect(builtin.connectors.find((c) => c.id === "slack")?.held).toBe("oauth");
    expect(builtin.connectors.find((c) => c.id === "gdrive")?.held).toBe("oauth");
  });

  it("the checked-in dev-signed fixture matches connectors.yaml (re-sign after editing it)", () => {
    expect(signedFixture().body).toEqual(builtin);
  });

  it("rejects an oauth entry that isn't held and duplicate ids", () => {
    const github = builtin.connectors.find((c) => c.id === "github")!;
    expect(ConnectorCatalog.safeParse({ ...builtin, connectors: [{ ...github, auth: "oauth" }] }).success).toBe(false);
    expect(ConnectorCatalog.safeParse({ ...builtin, connectors: [github, github] }).success).toBe(false);
  });

  it("readConfigFile finds it on disk in dev", () => {
    expect(readConfigFile("connectors.yaml")).toContain("connectors:");
  });
});

describe("signed connector catalog", () => {
  it("good: the dev-signed fixture verifies with the dev key passed explicitly", async () => {
    const v = await verifyConnectorCatalog(signedFixture(), DEV_KEYS);
    expect(v.ok).toBe(true);
  });

  it("bad: a changed body or signature fails", async () => {
    const tampered = signedFixture();
    tampered.body.connectors[0]!.name = "GitHub (evil)";
    expect(await verifyConnectorCatalog(tampered, DEV_KEYS)).toEqual({ ok: false, reason: "bad_signature" });
    const badSig = signedFixture();
    badSig.sig = `${badSig.sig.slice(0, -4)}AAAA`;
    expect(await verifyConnectorCatalog(badSig, DEV_KEYS)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("missing: no signature, unknown key, or the compiled-in (production) keys reject it", async () => {
    const { sig: _sig, ...noSig } = signedFixture();
    expect(await verifyConnectorCatalog(noSig, DEV_KEYS)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyConnectorCatalog(signedFixture())).toEqual({ ok: false, reason: "unknown_key" });
    expect(await verifyConnectorCatalog({ ...signedFixture(), ctx: "chalito.recipe-catalog.v1" }, DEV_KEYS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("a recipe-catalog signature can't pass as a connector catalog (separate context)", async () => {
    const builtin = loadBuiltinConnectors();
    const signed = await signConnectorCatalog(builtin, devKey);
    const { signDetached, fromB64url } = await import("@chalito/crypto");
    const crossSig = await signDetached("chalito.recipe-catalog.v1", builtin, await fromB64url(devKey.secretKey));
    expect((await verifyConnectorCatalog(signed, DEV_KEYS)).ok).toBe(true);
    expect((await verifyConnectorCatalog({ ...signed, sig: crossSig }, DEV_KEYS)).ok).toBe(false);
  });

  it("VerifiedConnectors applies only a newer verified catalog", async () => {
    const builtin = loadBuiltinConnectors();
    const vc = new VerifiedConnectors(builtin, DEV_KEYS);
    expect((await vc.offer(signedFixture())).applied).toBe(false); // same issuedAt
    const newer = { ...builtin, issuedAt: builtin.issuedAt + 1, connectors: builtin.connectors.slice(0, 2) };
    expect((await vc.offer(await signConnectorCatalog(newer, devKey))).applied).toBe(true);
    expect(vc.list()).toHaveLength(2);
    const prod = new VerifiedConnectors(builtin);
    expect((await prod.offer(await signConnectorCatalog(newer, devKey))).ok).toBe(false);
    expect(prod.list()).toHaveLength(builtin.connectors.length);
  });

  it("search matches id, name and description, case-insensitively", () => {
    const vc = new VerifiedConnectors(loadBuiltinConnectors());
    expect(vc.search("LINEAR").map((c) => c.id)).toEqual(["linear"]);
    expect(vc.search("").length).toBe(vc.list().length);
  });
});
