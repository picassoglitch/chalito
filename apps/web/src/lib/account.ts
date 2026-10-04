/**
 * Account deletion (apps/api src/account/routes.ts, /v1/account/*). Requesting it needs this
 * device (client role) and a passkey step-up; status, cancel and the export work for any of the
 * owner's sessions. The api writes an export first and deletes Chalito's data (never the hub
 * account) once the 7-day grace ends.
 */
export type DeletionStatus =
  | { status: "none" }
  | { status: "scheduled"; requestedAt: number; dueAt: number }
  /** Cancelled or done: nothing pending (the export may still exist). */
  | { status: "cancelled" | "deleted"; requestedAt: number; dueAt: number };

export type RequestResult =
  | { ok: true; dueAt: number }
  | { ok: false; reason: "passkey_required" | "step_up_failed" | "already_scheduled" | "failed" };

export interface AccountApi {
  status(): Promise<DeletionStatus | "error">;
  /** `stepUp`: a server-challenged passkey assertion (ChalitoProvider.assertPasskey). */
  request(stepUp: unknown): Promise<RequestResult>;
  cancel(): Promise<"ok" | "nothing_scheduled" | "failed">;
  /** The export as a file, or why not. */
  export(): Promise<Blob | "none" | "failed">;
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export const parseStatus = (body: unknown): DeletionStatus | null => {
  const b = body as { status?: unknown; requestedAt?: unknown; dueAt?: unknown } | null;
  if (b?.status === "none") return { status: "none" };
  if (
    (b?.status === "scheduled" || b?.status === "cancelled" || b?.status === "deleted") &&
    isTime(b.requestedAt) &&
    isTime(b.dueAt)
  )
    return { status: b.status, requestedAt: b.requestedAt, dueAt: b.dueAt };
  return null;
};

/** Days and hours left, to the nearest hour (never negative): "7 días y 0 horas" right after asking. */
export const timeLeft = (dueAt: number, now: number): { days: number; hours: number } => {
  const hours = Math.max(0, Math.round((dueAt - now) / 3_600_000));
  return { days: Math.floor(hours / 24), hours: hours % 24 };
};

export const httpAccount = (
  base: string,
  token: () => Promise<string | null>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): AccountApi => {
  const call = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Response | null> => {
    const bearer = await token();
    if (!base || !bearer) return null;
    try {
      return await fetchImpl(`${base}/v1/account${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
      });
    } catch {
      return null;
    }
  };
  const error = async (r: Response) => ((await r.json().catch(() => null)) as { error?: unknown } | null)?.error;
  return {
    status: async () => {
      const r = await call("GET", "/deletion");
      if (!r?.ok) return "error";
      return parseStatus(await r.json().catch(() => null)) ?? "error";
    },
    request: async (stepUp) => {
      const r = await call("POST", "/deletion", { stepUp });
      if (!r) return { ok: false, reason: "failed" };
      if (r.ok) {
        const b = (await r.json().catch(() => null)) as { dueAt?: unknown } | null;
        return isTime(b?.dueAt) ? { ok: true, dueAt: b.dueAt } : { ok: false, reason: "failed" };
      }
      const e = await error(r);
      if (e === "passkey_required" || e === "step_up_required") return { ok: false, reason: "passkey_required" };
      if (e === "step_up_failed" || e === "authenticator_cloned") return { ok: false, reason: "step_up_failed" };
      if (e === "already_scheduled") return { ok: false, reason: "already_scheduled" };
      return { ok: false, reason: "failed" };
    },
    cancel: async () => {
      const r = await call("DELETE", "/deletion");
      if (r?.ok) return "ok";
      return r && r.status === 404 ? "nothing_scheduled" : "failed";
    },
    export: async () => {
      const r = await call("GET", "/export");
      if (r?.ok) return r.blob();
      return r && r.status === 404 ? "none" : "failed";
    },
  };
};
