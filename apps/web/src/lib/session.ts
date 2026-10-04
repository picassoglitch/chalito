"use client";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type SessionState = { status: "loading" } | { status: "signed_out" } | { status: "signed_in"; session: Session };

/** The hub tier for the plan step: the api stores it in app_metadata when it mints the user. */
export const sessionTier = (s: Session): string | null => {
  const m = s.user.app_metadata as { chalito?: { tier?: unknown }; tier?: unknown } | undefined;
  const t = m?.chalito?.tier ?? m?.tier;
  return typeof t === "string" ? t : null;
};

export const useSession = (): SessionState => {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  useEffect(() => {
    let client;
    try {
      client = supabase();
    } catch {
      setState({ status: "signed_out" });
      return;
    }
    let alive = true;
    void client.auth.getSession().then(({ data }) => {
      if (alive) setState(data.session ? { status: "signed_in", session: data.session } : { status: "signed_out" });
    });
    const { data } = client.auth.onAuthStateChange((_e, session) =>
      setState(session ? { status: "signed_in", session } : { status: "signed_out" }),
    );
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);
  return state;
};
