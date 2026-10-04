/** Public configuration (inlined at build). Only the publishable Supabase key ever reaches the browser. */
export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  apiBase: (process.env.NEXT_PUBLIC_CHALITO_API_BASE ?? "").replace(/\/+$/, ""),
  hubUrl: (process.env.NEXT_PUBLIC_HUB_URL ?? "").replace(/\/+$/, ""),
};
