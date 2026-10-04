import { ApiError, type ApiClient } from "@chalito/client-keys";

/**
 * Rooms on the web (ADR 0010), the app-level parts: the room list and joining with a code. One
 * room's view (feed, keys, post, leave, report) is @chalito/rooms' RoomController.
 */
export type JoinError = "bad_code" | "full" | "rate_limited" | "failed";

export const roomApi = (api: ApiClient) => ({
  /** The raw client, for @chalito/rooms' RoomController (post, leave, report). */
  client: api,
  join: async (
    companionId: string,
    shortCode: string,
  ): Promise<{ ok: true; roomId: string } | { ok: false; reason: JoinError }> => {
    try {
      const r = await api.post<{ roomId: string }>("/v1/rooms/join", { companionId, shortCode });
      return { ok: true, roomId: r.roomId };
    } catch (err) {
      // An unknown, used-up or expired invite: 400/404/410; the owner's plan caps members: 402.
      if (err instanceof ApiError && [400, 404, 410].includes(err.status)) return { ok: false, reason: "bad_code" };
      if (err instanceof ApiError && err.status === 402) return { ok: false, reason: "full" };
      if (err instanceof ApiError && err.status === 429) return { ok: false, reason: "rate_limited" };
      return { ok: false, reason: "failed" };
    }
  },
});
export type RoomApi = ReturnType<typeof roomApi>;
