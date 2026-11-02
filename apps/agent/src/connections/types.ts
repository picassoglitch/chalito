// ADR 0023 connector shapes, shared with connections/proxy.ts (PR C defines this file identically).
export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  source: "verified" | "community" | "custom";
  transport: "remote" | "stdio";
  server: { url?: string } | { package: string; version: string; integrity?: string; command: string; args: string[] };
  auth: "none" | "token" | "oauth";
  /** Not installable yet: OAuth connectors are on hold (owner, 2026-11-01). */
  held?: "oauth";
}

export type InstalledConnector = ConnectorEntry & { installedAt: number; confirmedWarning: boolean };
