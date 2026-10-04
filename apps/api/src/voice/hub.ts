/**
 * Voice streams are admitted, metered and settled through the Chalyb hub (ADR 0016) by
 * @chalito/billing's HubStreamUsage; this is the interface the voice routes depend on.
 */
export type { MeterKind, StreamUsage as HubUsage } from "@chalito/billing";
