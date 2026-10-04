/**
 * Starter companions for onboarding (brief M5 step 2). The free roster and uploads arrive
 * in M8; until then these are the choices, and `DEFAULT_COMPANION` is preselected and used
 * when the user taps "Saltar".
 */
export const COMPANIONS = ["chalito", "luna", "tito"] as const;
export type CompanionId = (typeof COMPANIONS)[number];
export const DEFAULT_COMPANION: CompanionId = "chalito";
