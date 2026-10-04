"use client";

/** The parts of a Supabase Auth session the shell reads. */
export interface Session {
  access_token: string;
  user?: { id?: string; app_metadata?: Record<string, unknown> };
}

export type SessionState = { status: "loading" } | { status: "signed_out" } | { status: "signed_in"; session: Session };

/** The hub tier for the plan step: the api stores it in app_metadata when it mints the user. */
export const sessionTier = (s: Session): string | null => {
  const m = s.user?.app_metadata as { chalito?: { tier?: unknown }; tier?: unknown } | undefined;
  const t = m?.chalito?.tier ?? m?.tier;
  return typeof t === "string" ? t : null;
};

/** The browser's session, from the provider (one source for every screen). */
export { useSession } from "@/components/ChalitoProvider";
