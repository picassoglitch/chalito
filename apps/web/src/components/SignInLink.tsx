"use client";
import type { ReactNode } from "react";
import { hubLaunchUrl } from "@/lib/hub";
import { signInAndReturn } from "@/lib/next-cookie";

/**
 * Every "Entrar con Chalyb" goes through here: it remembers where to come back to and binds the
 * sign-in to this browser (the state nonce /auth/sso checks). Renders nothing without a hub URL.
 */
export const SignInLink = ({
  children,
  returnTo,
  className = "w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white",
}: {
  children: ReactNode;
  /** Where to land after signing in; the current page by default. */
  returnTo?: string;
  className?: string;
}) => {
  const launch = hubLaunchUrl();
  if (!launch) return null;
  return (
    <a
      className={className}
      href={launch}
      data-testid="sign-in"
      onClick={(e) => {
        e.preventDefault();
        signInAndReturn(returnTo ?? window.location.pathname + window.location.search);
      }}
    >
      {children}
    </a>
  );
};
