import type { Sql } from "postgres";
import { computeEntitlements, type HubClient } from "@chalito/billing";
import { hubTierOf, type Entitlements, type PlansConfig } from "@chalito/protocol";

/**
 * Entitlements for a turn (ADR 0013): the hub tier Chalito has for the user (chalito.users.tier,
 * written at SSO), the hub balance, and comped owners. Computed per turn; a hub that can't be
 * reached yields no managed allowance (free_min), failing closed. Trial: the hub (chalyb a5733df)
 * exposes no trial flag on balance or admit (VERIFIED_APIS "Brain APIs for the Mesa"), so
 * hubTrialActive stays false until it does.
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
    // users.tier is stored as sent; read it like the notifier's caps, not case-sensitively.
    const tier = hubTierOf(u?.tier);
    const balance = await p.hub
      .balance(owner)
      .then((b) => ({ remaining: b.remaining, unlimited: b.unlimited }))
      .catch(() => ({ remaining: 0, unlimited: false }));
    return computeEntitlements(
      {
        uid: owner,
        hubTier: tier,
        soloTier: null,
        hubTrialActive: false,
        hubBalanceRemaining: Math.max(0, balance.remaining),
        hubUnlimited: balance.unlimited,
        comped: p.comped(owner),
        now: p.now(),
      },
      p.plans,
    );
  };
