export { generateDeviceKeys, publicKeys, KeyVault } from "./keys.js";
export type { DeviceKeys, TrustedAgent } from "./keys.js";
export { DeviceClientKeys, passkeyStepUp } from "./client.js";
export type { StepUpResult } from "./client.js";
export {
  generateRecoveryCode,
  signDeviceRegistration,
  signCommand,
  signRevokeClient,
  signDecision,
  signEndorsement,
} from "./signing.js";
export type { StepUpAssertion } from "./signing.js";
export { agentFromGlyph, sealFor } from "./sealing.js";
export { registerPasskey, stepUpWithPasskey, assertWithServerChallenge, browserCeremonies } from "./webauthn.js";
export type { Ceremonies, DeviceSigner } from "./webauthn.js";
export { httpApi, ApiError } from "./api.js";
export type { ApiClient } from "./api.js";
export {
  PairingScanner,
  checkPairingGlyph,
  pairingDisplay,
  resolveShortCode,
  pairingHandoff,
  declinePairing,
  buildPairingClaim,
  claimPairing,
  buildEndorsedEnrolment,
  enrollEndorsed,
  enrollSignedIn,
  deviceFingerprint,
  keyFingerprint,
  revokeDevice,
} from "./pairing.js";
export type { PairingDisplay, ScanResult, ClaimRequest } from "./pairing.js";
export { deviceLogin } from "./device-login.js";
export {
  EndorseError,
  SIGN_IN_INTRODUCER,
  accountAgents,
  newAccountAgents,
  approveEndorsement,
  endorseGlyph,
  introducedAgents,
  resolveForEndorsement,
} from "./endorse.js";
export type { DirectoryDevice, DroppedAgent, EndorseTarget, IntroductionCheck } from "./endorse.js";
