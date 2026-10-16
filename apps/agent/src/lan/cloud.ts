import { LanGrant } from "@chalito/protocol";

/**
 * Where LAN pairing tokens come from: the cloud, as this device (migration 20261015000500,
 * `chalito.lan_token()`). The cloud is a directory here, not a root of trust: a token only lets a
 * device *try* a handshake; the link also needs a device key the directory lists, and everything
 * the link carries is verified by the receiver exactly as on the cloud path.
 */
export interface LanCloud {
  grant(): Promise<LanGrant>;
}

/** What the RPC needs from a supabase-js client (SupaClient in supabase-store.ts has it). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** snake_case row from SQL → LanGrant. */
export const grantFromRow = (row: unknown): LanGrant => {
  const r = (row ?? {}) as { tokens?: unknown[]; peers?: unknown[] };
  return LanGrant.parse({
    tokens: (r.tokens ?? []).map((t) => {
      const x = t as Record<string, unknown>;
      return { tid: x.tid, secret: x.secret, expiresAt: Number(x.expires_at) };
    }),
    peers: (r.peers ?? []).map((p) => {
      const x = p as Record<string, unknown>;
      return { deviceId: x.device_id, pubSign: x.pub_sign };
    }),
  });
};

export const supabaseLanCloud = (db: RpcClient): LanCloud => ({
  grant: async () => {
    const { data, error } = await db.rpc("lan_token", {});
    if (error) throw new Error(`lan_token: ${error.message}`);
    return grantFromRow(data);
  },
});
