import { DEFAULT_COMPANION as ROSTER_DEFAULT, ROSTER_IDS, rosterEntry, type RosterId } from "@chalito/roster";

/**
 * The companions to choose from: the free roster (M8, @chalito/roster, D-057). `DEFAULT_COMPANION`
 * is preselected at onboarding and used when the user taps "Saltar".
 */
export const COMPANIONS = ROSTER_IDS;
export type CompanionId = RosterId;
export const DEFAULT_COMPANION: CompanionId = ROSTER_DEFAULT;

/** The companion's display name in this locale (from the roster). */
export const companionName = (id: string, locale: "es" | "en"): string => rosterEntry(id)?.name[locale] ?? id;
