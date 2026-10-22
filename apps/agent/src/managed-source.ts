import type { ManagedBlock, ManagedCredential, ManagedSource } from "@chalito/adapters";

/** A refusal from /v1/coding/credentials, with the api's error code (out_of_energy, daily_cap, not_eligible, …). */
export class ManagedRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`IA de Chalyb refused the session: ${code}`);
  }
  get blocked(): ManagedBlock | null {
    return this.code === "out_of_energy" || this.code === "daily_cap" ? this.code : null;
  }
}

type Agent = "codex" | "gemini-cli" | "grok-build";

/** The api's /v1/coding/credentials as this device (ADR 0030). The token never leaves this process but into the CLI. */
export const apiManagedSource = (p: {
  apiBase: string;
  agent: Agent;
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}): ManagedSource => {
  const f = p.fetch ?? fetch;
  const call = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
    const res = await f(`${p.apiBase}/v1/coding/credentials${path}`, {
      method,
      headers: { authorization: `Bearer ${await p.accessToken()}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok)
      throw new ManagedRefused(res.status, typeof json?.error === "string" ? json.error : `http_${res.status}`);
    return json ?? {};
  };
  return {
    async issue(sid): Promise<ManagedCredential> {
      const r = await call("POST", "", { sid, agent: p.agent });
      const { id, token, baseUrl, defaultModel } = r;
      if (
        typeof id !== "string" ||
        typeof token !== "string" ||
        typeof baseUrl !== "string" ||
        typeof defaultModel !== "string"
      )
        throw new ManagedRefused(502, "bad_response");
      return { id, token, baseUrl, model: defaultModel };
    },
    async status(id) {
      const r = await call("GET", `/${encodeURIComponent(id)}`);
      const state = r.state === "active" || r.state === "revoked" || r.state === "expired" ? r.state : "revoked";
      const b = r.blockedReason;
      return { state, blockedReason: b === "out_of_energy" || b === "daily_cap" ? b : null };
    },
    async end(id) {
      await call("DELETE", `/${encodeURIComponent(id)}`);
    },
  };
};
