import { describe, expect, it } from "vitest";
import { ReleaseManifest, buildManifest, classify, isChannelObject, type BuiltArtifact } from "../src/manifest.js";

const H = "a".repeat(64);
const art = (name: string, signature?: string): BuiltArtifact => ({
  name,
  size: 1000,
  sha256: H,
  ...(signature ? { signature } : {}),
});
const ALL = [
  art("Chalito_1.2.0_amd64.AppImage", "sig-appimage\n"),
  art("Chalito_1.2.0_amd64.deb"),
  art("Chalito-1.2.0-1.x86_64.rpm"),
  art("Chalito_1.2.0_x64-setup.exe", "sig-nsis"),
  art("Chalito_1.2.0_universal.dmg"),
  art("Chalito_universal.app.tar.gz", "sig-app"),
  art("Chalito_1.2.0_amd64.AppImage.sig"),
  art("checksums.txt"),
];

describe("release manifest (latest.json)", () => {
  it("is Tauri's static format plus downloads, with bucket object paths for URLs", () => {
    const m = buildManifest({
      channel: "stable",
      version: "1.2.0",
      notes: "Primera beta",
      pubDate: new Date("2026-10-20T12:00:00Z"),
      artifacts: ALL,
      unsigned: { windows: true, macos: true, linux: false },
    });
    expect(m.platforms).toEqual({
      "linux-x86_64": { signature: "sig-appimage", url: "stable/1.2.0/Chalito_1.2.0_amd64.AppImage" },
      "windows-x86_64": { signature: "sig-nsis", url: "stable/1.2.0/Chalito_1.2.0_x64-setup.exe" },
      "darwin-aarch64": { signature: "sig-app", url: "stable/1.2.0/Chalito_universal.app.tar.gz" },
      "darwin-x86_64": { signature: "sig-app", url: "stable/1.2.0/Chalito_universal.app.tar.gz" },
    });
    expect(m.downloads?.linux?.map((d) => d.kind)).toEqual(["appimage", "deb", "rpm"]);
    expect(m.downloads?.windows?.map((d) => d.kind)).toEqual(["nsis"]);
    expect(m.downloads?.macos?.map((d) => d.kind)).toEqual(["dmg"]);
    expect(m.pub_date).toBe("2026-10-20T12:00:00.000Z");
    expect(m.unsigned).toEqual({ windows: true, macos: true, linux: false });
    expect(ReleaseManifest.parse(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it("refuses an updater artifact without its signature, or two for one platform", () => {
    const base = { channel: "stable" as const, version: "1.2.0", pubDate: new Date(), unsigned: {} };
    expect(() => buildManifest({ ...base, artifacts: [art("Chalito_1.2.0_x64-setup.exe")] })).toThrow(/no signature/);
    expect(() =>
      buildManifest({ ...base, artifacts: [art("a_x64-setup.exe", "s"), art("b_x64-setup.exe", "s")] }),
    ).toThrow(/two updater/);
  });

  it("classifies bundler outputs and ignores everything else", () => {
    expect(classify("x.app.tar.gz.sig")).toBeNull();
    expect(classify("x.msi")).toBeNull();
    expect(classify("Chalito_1.0.0_universal.dmg")).toMatchObject({ os: "macos", kind: "dmg", updater: [] });
  });

  it("isChannelObject: only this channel's objects, no traversal or URLs", () => {
    expect(isChannelObject("stable", "stable/1.2.0/Chalito_1.2.0_amd64.AppImage")).toBe(true);
    for (const bad of [
      "beta/1.2.0/x",
      "stable/../beta/x",
      "stable//x",
      "https://evil/stable/x",
      "stable/1.2.0/x y",
      "stable\\x",
      "/stable/x",
    ])
      expect(isChannelObject("stable", bad), bad).toBe(false);
  });
});
