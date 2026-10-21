import { AgentLink, DeviceId, LinkId, PubBox, PubSign } from "@chalito/protocol";
import type { LinkIdentity, LinkSpec } from "./ipc.js";

// D-070: a cross-device link is made on both computers with each other's keys recorded locally;
// the owner carries them between the two panels as text codes, so no key is read from the cloud.

const DEVICE_PREFIX = "chalito-pc:";
const LINK_PREFIX = "chalito-link:";

const toB64url = (s: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64url = (s: string): string | null => {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
};

const decode = (code: string, prefix: string): unknown => {
  const s = code.trim();
  if (!s.startsWith(prefix)) return null;
  const json = fromB64url(s.slice(prefix.length));
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
};

export const deviceCode = (id: LinkIdentity): string =>
  DEVICE_PREFIX + toB64url(JSON.stringify({ deviceId: id.deviceId, pubSign: id.pubSign, pubBox: id.pubBox }));

export const parseDeviceCode = (code: string): LinkIdentity | null => {
  const raw = decode(code, DEVICE_PREFIX) as Partial<Record<keyof LinkIdentity, unknown>> | null;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length !== 3) return null;
  const ok =
    DeviceId.safeParse(raw.deviceId).success &&
    PubSign.safeParse(raw.pubSign).success &&
    PubBox.safeParse(raw.pubBox).success;
  return ok ? { deviceId: raw.deviceId as string, pubSign: raw.pubSign as string, pubBox: raw.pubBox as string } : null;
};

export const linkCode = (spec: LinkSpec): string => LINK_PREFIX + toB64url(JSON.stringify(spec));

/** A link made on the other computer, checked as the agent will check it (and not yet expired). */
export const parseLinkCode = (code: string, now: number): LinkSpec | null => {
  const raw = decode(code, LINK_PREFIX);
  if (!raw || typeof raw !== "object") return null;
  const r = AgentLink.safeParse({ ...raw, v: 1, createdAt: now, createdBy: "local" });
  if (!r.success) return null;
  const { v: _v, createdAt: _c, createdBy: _b, ...spec } = r.data;
  return spec;
};

/** `lnk_` + 22 random id chars: the same id on both computers names the same link. */
export const newLinkId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const id = `lnk_${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  return LinkId.parse(id);
};
