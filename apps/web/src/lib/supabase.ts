"use client";
import { createBrowserSupabase, indexedDbStorage, type BrowserSupabase } from "@chalito/client";
import { env } from "./env";

let client: BrowserSupabase | null = null;

/**
 * The browser client for the hub Supabase project (ADR 0017), publishable key only. The
 * session lives in IndexedDB (packages/client), not localStorage.
 */
export const supabase = (): BrowserSupabase => {
  if (!client) {
    if (!env.supabaseUrl || !env.supabaseAnonKey) throw new Error("Supabase is not configured");
    client = createBrowserSupabase(env.supabaseUrl, env.supabaseAnonKey, indexedDbStorage());
  }
  return client;
};
