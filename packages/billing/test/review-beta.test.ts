/** Beta security review proof for R-M6 (docs/reviews/beta-security-review.md), kept as a regression test. */
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usageEvent } from "../src/billable.js";
import { HubClient } from "../src/hub.js";
import { MemoryOutbox, drainOutbox } from "../src/outbox.js";
import { HUB_TOKEN, hubMock } from "./hub-mock.js";

const { server, state } = hubMock();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
const hub = new HubClient({ baseUrl: "https://www.chalyb.com", token: HUB_TOKEN });
const NOW = 1_790_000_000_000;
// The hub mock judges occurred_at windows on the test clock.
state.now = () => NOW;

describe("R-M6: one user's permanent 4xx doesn't dead-letter everyone else's usage", () => {
  it("only the failing user's events go dead", async () => {
    server.use(
      http.post("https://www.chalyb.com/api/engines/chalito/usage", async ({ request }) => {
        // As the real hub: one user per request, an unknown user is a 404 (usage/route.ts:75-90).
        const body = (await request.json()) as { external_user_id?: string };
        if (!body.external_user_id) return HttpResponse.json({ error: "external_user_id required" }, { status: 400 });
        return body.external_user_id === "ghost"
          ? HttpResponse.json({ error: "unknown user_id" }, { status: 404 })
          : HttpResponse.json({ ok: true });
      }),
    );
    const mk = (owner: string, i: number) =>
      usageEvent(
        { owner, billingMode: "managed", origin: "sms.message" },
        {
          kind: "sms.segments",
          provider: "twilio",
          amount: 1,
          costUsdMicros: 181_900,
          occurredAt: NOW,
          sourceId: `sms:${owner}:${i}`,
        },
      );
    const box = new MemoryOutbox();
    await box.enqueue("ghost", [mk("ghost", 0)]);
    await box.enqueue(
      "u1",
      Array.from({ length: 20 }, (_, i) => mk("u1", i)),
    );
    await drainOutbox({ store: box, hub, now: () => NOW, alert: () => {} });
    expect(box.rows.filter((r) => r.owner === "u1").every((r) => r.status === "sent")).toBe(true);
    expect(box.rows.find((r) => r.owner === "ghost")!.status).toBe("dead");
  });
});
