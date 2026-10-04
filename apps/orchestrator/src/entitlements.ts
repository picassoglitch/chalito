import type { Sql } from "postgres";
import { computeEntitlements, type HubClient } from "@chalito/billing";
import { HubTierId, type Entitlements, type PlansConfig } from "@chalito/protocol";

/**
 * Entitlements for a turn (ADR 0013): the hub tier Chalito has for the user (chalito.users.tier,
 * written at SSO), the hub balance, and comped owners. Computed per turn; a hub that can't be
 * reached yields no managed allowance (free_min), failing closed.
 */
export const hubEntitlements =
  (p: {
    sql: Sql;
    hub: Pick<HubClient, "balance">;
    plans: PlansConfig;
    comped: (uid: string) => boolean;
    now: () => number;
  }) =>
  async (owner: string): Promise<Entitlements> => {
    const [u] = await p.sql<{ tier: string | null }[]>`select tier from chalito.users where id = ${owner}`;
    const tier = HubTierId.safeParse(u?.tier);
    const remaining = await p.hub
      .balance(owner)
      .then((b) => b.remaining)
      .catch(() => 0);
    return computeEntitlements(
      {
        uid: owner,
        hubTier: tier.success ? tier.data : null,
        soloTier: null,
        hubTrialActive: false,
        hubBalanceRemaining: Math.max(0, remaining),
        comped: p.comped(owner),
        now: p.now(),
      },
      p.plans,
    );
  };
