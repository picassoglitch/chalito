// @vitest-environment node
import { describe, expect, it } from "vitest";
import { reportBody } from "@chalito/rooms";

const ME = "chl_" + "a".repeat(26);
const ANA = "chl_" + "b".repeat(26);

describe("rooms (web)", () => {
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
