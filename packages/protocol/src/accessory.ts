import { z } from "zod";
import { ApprovalId, EpochMs, SessionId } from "./common.js";

/** Local accessory messages. This is not a public or unauthenticated approval endpoint. */
export const ApprovalConsoleCommand = z.discriminatedUnion("type", [
  z
    .object({
      v: z.literal(1),
      type: z.literal("decide"),
      aid: ApprovalId,
      ticket: z.string().min(16).max(128),
      allow: z.boolean(),
    })
    .strict(),
  z.object({ v: z.literal(1), type: z.literal("next") }).strict(),
  z.object({ v: z.literal(1), type: z.literal("previous") }).strict(),
]);
export type ApprovalConsoleCommand = z.infer<typeof ApprovalConsoleCommand>;

export const ApprovalConsoleFrame = z
  .object({
    v: z.literal(1),
    type: z.literal("approval-console"),
    state: z.enum(["empty", "offline", "revoked", "pending", "phone_required", "unverified", "busy"]),
    count: z.number().int().min(0),
    position: z.number().int().min(0),
    approval: z
      .object({
        aid: ApprovalId,
        sid: SessionId,
        computer: z.string().max(120),
        agent: z.string().max(80),
        summary: z.string().max(320),
        risk: z.enum(["LOW", "MED", "HIGH", "CRITICAL"]),
        expiresAt: EpochMs,
        ticket: z.string().min(16).max(128),
        canApprove: z.boolean(),
        canDeny: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ApprovalConsoleFrame = z.infer<typeof ApprovalConsoleFrame>;
