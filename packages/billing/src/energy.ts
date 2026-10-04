import { createHash } from "node:crypto";
import { loadRechargeCopy } from "@chalito/config";
import type { Entitlements, HubAdmitRequest } from "@chalito/protocol";
import type { z } from "zod";
import type { HubClient } from "./hub.js";

/**
 * Out of energy, in character (brief §5 M12, ADR 0013): the turn finishes on free_min, the
 * companion plays "tired" and says a recharge line; an inline "¿Por qué?" chip opens /creditos.
 * Never a modal or billing popup.
 */
export interface OutOfEnergy {
  kind: "out_of_energy";
  profile: "free_min";
  animation: "tired";
  line: string;
  chip: { label: string; href: "/creditos" | "/en/creditos" };
  presentation: "inline";
}

const COPY = { es: loadRechargeCopy("es"), en: loadRechargeCopy("en") };

/** Deterministic but varied: the same key always picks the same line. */
export const outOfEnergy = (locale: "es" | "en", key = ""): OutOfEnergy => {
  const copy = COPY[locale];
  const i = createHash("sha256").update(key).digest().readUInt32BE(0) % copy.lines.length;
  return {
    kind: "out_of_energy",
    profile: "free_min",
    animation: "tired",
    line: copy.lines[i]!,
    chip: { label: copy.chip, href: locale === "es" ? "/creditos" : "/en/creditos" },
    presentation: "inline",
  };
};

export type ManagedGate =
  | { ok: true; reservationId: string; remaining: number }
  /** No balance: free_min plus the recharge line and chip. */
  | { ok: false; outOfEnergy: OutOfEnergy }
  /** Refused for another reason (caps, concurrency, hub unreachable): free_min, no recharge line. */
  | { ok: false; refused: string; profile: "free_min" };

/**
 * Admits managed work, or says why not. Entitlements without a managed allowance never call
 * the hub. An unreachable hub fails closed (managed spend stops; safety features and BYO don't).
 */
export const admitManaged = async (p: {
  hub: Pick<HubClient, "admit" | "settle">;
  entitlements: Pick<Entitlements, "managedAllowance">;
  request: z.input<typeof HubAdmitRequest>;
  locale: "es" | "en";
}): Promise<ManagedGate> => {
  const key = p.request.external_job_id;
  if (p.entitlements.managedAllowance.status === "free_min")
    return { ok: false, outOfEnergy: outOfEnergy(p.locale, key) };
  if (p.entitlements.managedAllowance.status !== "enabled")
    return { ok: false, refused: "allowance_unset", profile: "free_min" };
  let res;
  try {
    res = await p.hub.admit(p.request);
  } catch {
    return { ok: false, refused: "hub_unavailable", profile: "free_min" };
  }
  if (!res.allowed) {
    return res.reason === "no_tokens"
      ? { ok: false, outOfEnergy: outOfEnergy(p.locale, key) }
      : { ok: false, refused: res.reason, profile: "free_min" };
  }
  if (res.balance.remaining <= 0) {
    await p.hub.settle({ reservation_id: res.reservation_id, outcome: "cancelled" }).catch(() => undefined);
    return { ok: false, outOfEnergy: outOfEnergy(p.locale, key) };
  }
  return { ok: true, reservationId: res.reservation_id, remaining: res.balance.remaining };
};
