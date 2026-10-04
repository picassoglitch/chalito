import { describe, expect, it } from "vitest";
import { branchTarget } from "./stack.js";

const MAIN = "uqcbziwdgbnzehipzjxp";
const BRANCH = "abcdefghijklmnopqrst";

describe("the rehearsal's non-local target (scripts/nexo-ai-dryrun.sh)", () => {
  it("accepts a branch whose host is the branch ref", () => {
    expect(branchTarget(`https://${BRANCH}.supabase.co/auth/v1`, BRANCH, MAIN)).toBe(true);
  });

  it("never the main project, a mismatched host, or without both refs", () => {
    expect(branchTarget(`https://${MAIN}.supabase.co/auth/v1`, MAIN, MAIN)).toBe(false);
    expect(branchTarget(`https://${MAIN}.supabase.co/auth/v1`, BRANCH, MAIN)).toBe(false);
    expect(branchTarget(`https://${BRANCH}.supabase.co/auth/v1`, BRANCH, undefined)).toBe(false);
    expect(branchTarget(`https://${BRANCH}.supabase.co/auth/v1`, undefined, MAIN)).toBe(false);
    expect(branchTarget(`https://${BRANCH}.evil.example/auth/v1`, BRANCH, MAIN)).toBe(false);
    expect(branchTarget(`http://${BRANCH}.supabase.co/auth/v1`, BRANCH, MAIN)).toBe(false);
    expect(branchTarget(`https://${BRANCH}.supabase.co/auth/v1`, "BAD-REF", MAIN)).toBe(false);
  });
});
