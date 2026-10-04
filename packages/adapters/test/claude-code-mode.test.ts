import fc from "fast-check";
import { RemotePermissionMode } from "@chalito/protocol";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/claude-code/index.js";
import { fakeClaudeCode } from "../src/testing.js";

/** D-004: the SDK's permission mode is always explicit and never one of the unattended modes. */
const FORBIDDEN = ["auto", "dontAsk", "bypassPermissions"];
const mode = fc.constantFrom(...RemotePermissionMode.options);

const runSession = async (start: RemotePermissionMode, changes: RemotePermissionMode[]) => {
  const fake = fakeClaudeCode([[{ say: "ok" }]]);
  const adapter = new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} });
  const h = await adapter.start({
    sid: "s1",
    cwd: "/ws",
    prompt: "hola",
    origin: "client:phone1",
    permissionMode: start,
    gate: async () => ({ allow: true }),
    askUser: async () => ({}),
    onEvent: () => {},
  });
  for (const m of changes) await h.setPermissionMode(m);
  h.close();
  await h.done;
  return fake.run;
};

describe("Claude Code permission mode", () => {
  it("is set explicitly for every allowed start mode, including after setPermissionMode", async () => {
    await fc.assert(
      fc.asyncProperty(mode, fc.array(mode, { maxLength: 6 }), async (start, changes) => {
        const run = await runSession(start, changes);
        expect(run.options).toBeDefined();
        expect(Object.hasOwn(run.options!, "permissionMode")).toBe(true);
        expect(run.options!.permissionMode).toBe(start);
        expect(run.options!.allowDangerouslySkipPermissions).toBe(false);
        expect(run.modes).toEqual([start, ...changes]);
        for (const m of run.modes) {
          expect(FORBIDDEN).not.toContain(m);
          expect(RemotePermissionMode.options).toContain(m);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("the remote mode type cannot express the unattended modes", () => {
    for (const m of FORBIDDEN) expect(RemotePermissionMode.safeParse(m).success).toBe(false);
  });

  it("refuses bogus modes at runtime and never forwards them to the SDK", async () => {
    for (const bogus of [...FORBIDDEN, "garbage", "", undefined]) {
      const fake = fakeClaudeCode([[{ say: "ok" }]]);
      const adapter = new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} });
      const base = {
        sid: "s1",
        cwd: "/ws",
        prompt: "hola",
        origin: "local" as const,
        gate: async () => ({ allow: true as const }),
        askUser: async () => ({}),
        onEvent: () => {},
      };
      await expect(
        adapter.start({ ...base, permissionMode: bogus as unknown as RemotePermissionMode }),
      ).rejects.toThrow(/Refused permission mode/);
      expect(fake.run.options).toBeUndefined();

      const h = await adapter.start({ ...base, permissionMode: "default" });
      await expect(h.setPermissionMode(bogus as unknown as RemotePermissionMode)).rejects.toThrow(
        /Refused permission mode/,
      );
      expect(fake.run.modes).toEqual(["default"]);
      h.close();
      await h.done;
    }
  });
});
