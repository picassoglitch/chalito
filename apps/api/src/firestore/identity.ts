import type { Auth } from "firebase-admin/auth";
import type { IdentityClaims, IdentityIssuer } from "../repo.js";

/** Firebase uid of a device. Each device has its own identity so it can be disabled alone. */
export const deviceUid = (deviceId: string) => `d_${deviceId}`;

/** IdentityIssuer over Firebase Auth custom tokens; verification checks refresh-token revocation. */
export class FirebaseIssuer implements IdentityIssuer {
  constructor(private readonly auth: Auth) {}

  mintUser(owner: string, tier: string) {
    return this.auth.createCustomToken(owner, { role: "user", owner, tier });
  }

  mintDevice(owner: string, deviceId: string, role: "client" | "agent") {
    return this.auth.createCustomToken(deviceUid(deviceId), { role, owner, deviceId });
  }

  mintPairingWatch(codeId: string) {
    return this.auth.createCustomToken(`p_${codeId}`, { role: "pairing", owner: "pairing", pairingCode: codeId });
  }

  async verify(token: string): Promise<IdentityClaims> {
    const claims = await this.auth.verifyIdToken(token, true);
    return {
      uid: String(claims.uid),
      role: typeof claims.role === "string" ? claims.role : "",
      owner: typeof claims.owner === "string" ? claims.owner : "",
      ...(typeof claims.deviceId === "string" ? { deviceId: claims.deviceId } : {}),
    };
  }

  async disableDevice(deviceId: string) {
    const uid = deviceUid(deviceId);
    await this.auth.updateUser(uid, { disabled: true }).catch(() => undefined);
    await this.auth.revokeRefreshTokens(uid).catch(() => undefined);
  }
}
