import { env } from "./env";

/** "Entrar con Chalyb": the hub's engine launch route (src/app/auth/launch/[slug]/route.ts on the hub). */
export const hubLaunchUrl = (): string | null => (env.hubUrl ? `${env.hubUrl}/auth/launch/chalito` : null);
