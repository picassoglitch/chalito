import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/policy/index.js";
import { policyRules } from "../src/policy-view.js";

describe("the policy as the panel lists it", () => {
  it("every section, localized, with allow/ask/deny", () => {
    const p = { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: "/home/ana/chalito" }] };
    const en = policyRules(p, "en");
    expect(en[0]).toEqual({ id: "workspace:chalito", summary: "Folder “chalito”: /home/ana/chalito", effect: "allow" });
    expect(en.find((r) => r.id === "egress.mcpCards")?.effect).toBe("deny");
    expect(en.find((r) => r.id === "origins.mcp")).toEqual({
      id: "origins.mcp",
      summary: "Prompts from connected apps (MCP)",
      effect: "allow",
    });
    expect(policyRules(p, "es").map((r) => r.id)).toEqual(en.map((r) => r.id));
    expect(policyRules(DEFAULT_POLICY, "es")[0]).toEqual({
      id: "workspaces",
      summary: "Sin carpetas: no corre ninguna sesión",
      effect: "deny",
    });
  });
});
