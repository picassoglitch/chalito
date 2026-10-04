import { describe, expect, it } from "vitest";
import type { IdentityIssuer } from "../../src/repo.js";
import { owner } from "./fixtures.js";

export interface IdentityHarness {
  issuer: IdentityIssuer;
  /** Turns a minted credential into the bearer a client would send (e.g. Firebase: sign in, take the ID token). */
  toBearer(minted: string): Promise<string>;
}

/** Behaviour every IdentityIssuer must have. */
export const runIdentityContract = (name: string, make: () => IdentityHarness | Promise<IdentityHarness>) => {
  describe(`IdentityIssuer contract: ${name}`, () => {
    it("a device credential verifies with its role, owner and device id", async () => {
      const { issuer, toBearer } = await make();
      const o = owner();
      const claims = await issuer.verify(await toBearer(await issuer.mintDevice(o, "dev_contractA", "agent")));
      expect(claims).toMatchObject({ role: "agent", owner: o, deviceId: "dev_contractA" });
      expect(claims.uid).toBeTruthy();
    });

    it("a user credential verifies with role user and no device id", async () => {
      const { issuer, toBearer } = await make();
      const o = owner();
      const claims = await issuer.verify(await toBearer(await issuer.mintUser(o, "pro")));
      expect(claims).toMatchObject({ role: "user", owner: o });
      expect(claims.deviceId).toBeUndefined();
    });

    it("a pairing-watch credential verifies as role pairing, never a user or device", async () => {
      const { issuer, toBearer } = await make();
      const claims = await issuer.verify(await toBearer(await issuer.mintPairingWatch(`code_${Date.now()}`)));
      expect(claims.role).toBe("pairing");
      expect(claims.deviceId).toBeUndefined();
    });

    it("garbage and empty bearers are rejected", async () => {
      const { issuer } = await make();
      await expect(issuer.verify("not-a-token")).rejects.toBeTruthy();
      await expect(issuer.verify("")).rejects.toBeTruthy();
    });

    it("disableDevice stops that device's existing credential and nobody else's", async () => {
      const { issuer, toBearer } = await make();
      const o = owner();
      const id = `dev_c${Date.now()}`;
      const mine = await toBearer(await issuer.mintDevice(o, id, "client"));
      const other = await toBearer(await issuer.mintDevice(o, `${id}b`, "client"));
      await issuer.disableDevice(id);
      await expect(issuer.verify(mine)).rejects.toBeTruthy();
      expect((await issuer.verify(other)).deviceId).toBe(`${id}b`);
    });

    it("disableDevice for a device that never signed in does not throw", async () => {
      const { issuer } = await make();
      await issuer.disableDevice(`dev_never${Date.now()}`);
    });
  });
};
