// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ApiError, type ApiClient } from "@chalito/client-keys";
import { reportBody } from "@chalito/rooms";
import { roomApi } from "@/lib/rooms";

const ME = "chl_" + "a".repeat(26);
const ANA = "chl_" + "b".repeat(26);

describe("rooms (web)", () => {
  it("join maps bad, used or expired codes, a full room and rate limits", async () => {
    const failing = (status: number): ApiClient => ({
      post: async () => {
        throw new ApiError(status, "x");
      },
    });
    for (const s of [400, 404, 410])
      expect(await roomApi(failing(s)).join(ME, "AAAA-BBBB")).toEqual({ ok: false, reason: "bad_code" });
    expect(await roomApi(failing(402)).join(ME, "AAAA-BBBB")).toEqual({ ok: false, reason: "full" });
    expect(await roomApi(failing(429)).join(ME, "AAAA-BBBB")).toEqual({ ok: false, reason: "rate_limited" });
    const ok: ApiClient = { post: async <T>() => ({ roomId: "r9" }) as T };
    expect(await roomApi(ok).join(ME, "AAAA-BBBB")).toEqual({ ok: true, roomId: "r9" });
  });

  it("a report carries the decrypted text ONLY with the opt-in, and only for an event (UI promise)", () => {
    expect(reportBody(ME, { eventId: "e1", reason: "spam" })).not.toHaveProperty("attachedPlaintext");
    expect(reportBody(ME, { eventId: "e1", reason: "abuse", attachText: "texto" })).toMatchObject({
      attachedPlaintext: "texto",
      attachPlaintext: true,
    });
    expect(reportBody(ME, { memberCompanionId: ANA, reason: "other", attachText: "x" })).not.toHaveProperty(
      "attachedPlaintext",
    );
  });
});
