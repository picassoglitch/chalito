import type { Os } from "./plan.js";

/**
 * The bun-compiled agent (apps/agent, ADR 0004) ships as the Tauri sidecar
 * `binaries/chalito-agent-<triple>`. macOS builds are universal, so the two Apple binaries are
 * merged with `lipo` into `chalito-agent-universal-apple-darwin` (VERIFIED_APIS §2: per-arch
 * sidecars can't be mixed into a universal bundle). `tauri build --target universal-apple-darwin`
 * still compiles each arch first, and each of those builds checks for its own
 * `chalito-agent-<arch>` resource, so the per-arch binaries sit next to the universal one.
 */
export interface SidecarStep {
  kind: "copy" | "lipo";
  from: string[];
  to: string;
}

export const sidecarPlan = (os: Os, agentDist: string, binDir: string): SidecarStep[] => {
  const src = (t: string) => `${agentDist}/chalito-agent-${t}`;
  const dst = (t: string) => `${binDir}/chalito-agent-${t}`;
  switch (os) {
    case "linux":
      return [{ kind: "copy", from: [src("x86_64-unknown-linux-gnu")], to: dst("x86_64-unknown-linux-gnu") }];
    case "windows":
      return [{ kind: "copy", from: [src("x86_64-pc-windows-msvc.exe")], to: dst("x86_64-pc-windows-msvc.exe") }];
    case "macos":
      return [
        { kind: "copy", from: [src("aarch64-apple-darwin")], to: dst("aarch64-apple-darwin") },
        { kind: "copy", from: [src("x86_64-apple-darwin")], to: dst("x86_64-apple-darwin") },
        {
          kind: "lipo",
          from: [src("aarch64-apple-darwin"), src("x86_64-apple-darwin")],
          to: dst("universal-apple-darwin"),
        },
      ];
  }
};
