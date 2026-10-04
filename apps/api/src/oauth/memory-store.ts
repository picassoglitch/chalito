import type {
  AuthorizationRequest,
  CodeRecord,
  Grant,
  McpStore,
  OAuthClient,
  TokenRecord,
  TokenWithGrant,
} from "./model.js";

/** In-memory McpStore for unit tests. */
export class MemoryMcpStore implements McpStore {
  clients = new Map<string, OAuthClient>();
  requests = new Map<string, AuthorizationRequest>();
  grants = new Map<string, Grant>();
  codes = new Map<string, CodeRecord>();
  tokens = new Map<string, TokenRecord>();
  approvals = new Map<string, { owner: string; status: string; recommendations: unknown[] }>();
  sessions = new Map<string, string>();
  devices = new Set<string>();
  mesaTurns: { owner: string; mid: string; tid: string; doc: Record<string, unknown> }[] = [];
  commands: { owner: string; targetDeviceId: string; id: string; env: unknown; expiresAt: number }[] = [];
  sharing = new Map<string, { enabled: boolean; ackAt: number | null }>();

  #g = (owner: string, cid: string) => `${owner}/${cid}`;

  async getClient(id: string) {
    return this.clients.get(id) ?? null;
  }
  async putClient(c: OAuthClient) {
    this.clients.set(c.clientId, c);
  }
  async putRequest(r: AuthorizationRequest) {
    this.requests.set(r.requestId, r);
  }
  async getRequest(id: string, now: number) {
    const r = this.requests.get(id);
    return r && r.expiresAt > now ? r : null;
  }
  async deleteRequest(id: string) {
    this.requests.delete(id);
  }
  async createGrant(g: Grant) {
    this.grants.set(this.#g(g.owner, g.cid), g);
  }
  async listGrants(owner: string) {
    return [...this.grants.values()].filter((g) => g.owner === owner);
  }
  async revokeGrant(owner: string, cid: string, at: number) {
    const g = this.grants.get(this.#g(owner, cid));
    if (!g) return false;
    g.revokedAt = at;
    for (const [h, t] of this.tokens) if (t.owner === owner && t.cid === cid) this.tokens.delete(h);
    for (const [h, c] of this.codes) if (c.owner === owner && c.cid === cid) this.codes.delete(h);
    return true;
  }
  async touchGrant(owner: string, cid: string, at: number) {
    const g = this.grants.get(this.#g(owner, cid));
    if (g) g.lastUsedAt = at;
  }
  async putCode(c: CodeRecord) {
    this.codes.set(c.codeHash, c);
  }
  async takeCode(h: string, now: number) {
    const c = this.codes.get(h);
    this.codes.delete(h);
    return c && c.expiresAt > now ? c : null;
  }
  async putToken(t: TokenRecord) {
    this.tokens.set(t.tokenHash, t);
  }
  async getToken(h: string): Promise<TokenWithGrant | null> {
    const t = this.tokens.get(h);
    const g = t && this.grants.get(this.#g(t.owner, t.cid));
    return t && g ? { ...t, provider: g.provider, grantRevokedAt: g.revokedAt } : null;
  }
  async useRefresh(h: string, at: number) {
    const t = this.tokens.get(h);
    if (!t || t.kind !== "refresh") return "missing" as const;
    if (t.usedAt !== null) return "reused" as const;
    t.usedAt = at;
    return "ok" as const;
  }
  async deleteToken(h: string) {
    this.tokens.delete(h);
  }
  async recommend(owner: string, aid: string, rec: { from: string; allow: boolean; note: string; at: number }) {
    const a = this.approvals.get(`${owner}/${aid}`);
    if (!a || a.status !== "pending") return "not_found" as const;
    if (a.recommendations.length >= 20) return "full" as const;
    a.recommendations.push(rec);
    return "ok" as const;
  }
  async insertMesaTurn(owner: string, mid: string, tid: string, doc: Record<string, unknown>) {
    this.mesaTurns.push({ owner, mid, tid, doc });
  }
  async sessionDevice(owner: string, sid: string) {
    return this.sessions.get(`${owner}/${sid}`) ?? null;
  }
  async insertCommand(owner: string, targetDeviceId: string, id: string, env: unknown, expiresAt: number) {
    if (!this.devices.has(`${owner}/${targetDeviceId}`)) return "no_device" as const;
    this.commands.push({ owner, targetDeviceId, id, env, expiresAt });
    return "ok" as const;
  }
  async setSharing(owner: string, scope: "session" | "device", target: string, enabled: boolean, ackAt: number | null) {
    this.sharing.set(`${owner}/${scope}/${target}`, { enabled, ackAt });
  }
}
