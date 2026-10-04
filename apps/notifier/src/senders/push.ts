import webpush from "web-push";
import type { PushPayload } from "@chalito/escalation";
import type { PushSubscriptionRecord } from "../store.js";

export type PushResult = "ok" | "gone" | "failed";

export interface PushSender {
  send(sub: PushSubscriptionRecord, payload: PushPayload, ttlSec: number): Promise<PushResult>;
}

const URGENCY = { low: "low", normal: "normal", high: "high", critical: "high" } as const;

/** Standard Web Push with VAPID (RFC 8030/8291/8292; D-050). The payload is metadata only. */
export const webPushSender = (vapid: { subject: string; publicKey: string; privateKey: string }): PushSender => ({
  async send(sub, payload, ttlSec) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        vapidDetails: vapid,
        TTL: ttlSec,
        urgency: URGENCY[payload.urgency],
      });
      return "ok";
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      return status === 404 || status === 410 ? "gone" : "failed";
    }
  },
});
