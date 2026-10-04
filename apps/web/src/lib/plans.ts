import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { PlansConfig } from "@chalito/protocol";
import { landingPlans, type LandingPlans } from "./landing-plans";

/** The landing's plans section, straight from packages/config/plans.yaml (validated; a bad file fails the render). */
export const plansForLanding = (): LandingPlans =>
  landingPlans(PlansConfig.parse(parse(readFileSync(join(process.cwd(), "../../packages/config/plans.yaml"), "utf8"))));
