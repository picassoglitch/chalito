import { createHash } from "node:crypto";
import { canonicalize } from "@chalito/crypto";
import type { Policy } from "./schema.js";

/** SHA-256 of the canonical (JCS) policy; reported as `policyHash`. */
export const policyHash = (p: Policy): string => createHash("sha256").update(canonicalize(p)).digest("hex");
