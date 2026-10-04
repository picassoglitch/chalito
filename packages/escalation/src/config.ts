import { loadEscalation, type EscalationConfig } from "@chalito/config";

export type { EscalationConfig };

/** packages/config/escalation.yaml, loaded once. Callers may pass their own config to decide(). */
export const DEFAULT_ESCALATION: EscalationConfig = loadEscalation();
