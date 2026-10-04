/**
 * Server-side settings and phone verification for the UI shells (PWA, desktop panel). A
 * separate entry point because it depends on @chalito/ui (React): `@chalito/client` itself
 * stays loadable by non-UI consumers (client-keys, the agent's tests).
 */
export * from "./settings.js";
export * from "./phone.js";
