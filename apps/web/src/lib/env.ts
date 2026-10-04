/** Public configuration (inlined at build). Only the publishable Supabase key ever reaches the browser. */
export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  apiBase: (process.env.NEXT_PUBLIC_CHALITO_API_BASE ?? "").replace(/\/+$/, ""),
  /** apps/orchestrator (Mesa, BYO keys, usage). Falls back to the api's host when unset. */
  orchestratorBase: (
    process.env.NEXT_PUBLIC_CHALITO_ORCHESTRATOR_BASE ||
    process.env.NEXT_PUBLIC_CHALITO_API_BASE ||
    ""
  ).replace(/\/+$/, ""),
  /** The hub's www host (the apex drops auth): https://www.chalyb.com */
  hubUrl: (process.env.NEXT_PUBLIC_HUB_URL ?? "").replace(/\/+$/, ""),
  /** The notifier's VAPID public key (apps/notifier VAPID_PUBLIC_KEY), for Web Push. */
  vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
};

/**
 * DEV/TEST ONLY: an in-browser mock backend (fake Supabase + simulated agent + stub keys) for
 * local work and the Playwright suite. next.config.ts refuses to build with it on Vercel, and
 * when it's off the whole `src/dev` tree is dead code that never reaches the bundle.
 */
export const DEV_BACKEND = process.env.NEXT_PUBLIC_CHALITO_DEV_BACKEND === "1";
