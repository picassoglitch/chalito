import type { RiskTier } from "@chalito/protocol";

// Conexiones contract 2026-11-01. PR B's store.ts writes ~/.chalito/connectors.json; the proxy only reads it.
export type ConnectorSource = "verified" | "community" | "custom";
export type ConnectorTransport = "remote" | "stdio";
export type ConnectorAuth = "none" | "token" | "oauth";

export type ConnectorServer =
  { url?: string } | { package: string; version: string; integrity?: string; command: string; args: string[] };

export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  source: ConnectorSource;
  transport: ConnectorTransport;
  server: ConnectorServer;
  auth: ConnectorAuth;
  held?: "oauth";
}

export type InstalledConnector = ConnectorEntry & {
  installedAt: number | string;
  confirmedWarning: boolean;
  // Proposed to PR B (not in the contract): stdio env names, each filled from keychain chalito.connector.<id>.<NAME>.
  secretEnv?: string[];
};

export interface ConnectorsFile {
  v: 1;
  installed: InstalledConnector[];
}

/** `read` tools are listed as read-only; everything else is `write` (ADR 0023 §1). */
export type ToolTier = "read" | "write";

/** What the proxy stamps on each call before the gate sees it. */
export interface ConnectorStamp {
  connectorId: string;
  source: ConnectorSource;
  tool: string;
  tier: ToolTier;
  risk: RiskTier;
}
