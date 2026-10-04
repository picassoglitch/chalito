"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let client: SupabaseClient | null = null;

/** The browser client for the hub Supabase project (ADR 0017), with the publishable key. */
export const supabase = (): SupabaseClient => {
  if (!client) {
    if (!env.supabaseUrl || !env.supabaseAnonKey) throw new Error("Supabase is not configured");
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
};
