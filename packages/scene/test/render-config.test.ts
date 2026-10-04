import { describe, expect, it } from "vitest";
import { loadRender } from "@chalito/config";
import { RENDER_DEFAULTS, pickQuality } from "../src/index.js";

describe("render quality", () => {
  it("matches packages/config/render.yaml", () => {
    const cfg = loadRender();
    expect(RENDER_DEFAULTS).toEqual({ default: cfg.default, levels: cfg.levels, auto: cfg.auto });
  });

  it("auto: software GL → bajo; slow → bajo; near the cap → alto; otherwise medio", () => {
    expect(pickQuality({ renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))", fps: 60 })).toBe("bajo");
    expect(pickQuality({ renderer: "llvmpipe (LLVM 17.0.6, 256 bits)", fps: 60 })).toBe("bajo");
    expect(pickQuality({ renderer: "ANGLE (NVIDIA)", fps: 25 })).toBe("bajo");
    expect(pickQuality({ renderer: "ANGLE (NVIDIA)", fps: 59 })).toBe("alto");
    expect(pickQuality({ renderer: "ANGLE (Intel)", fps: 45 })).toBe("medio");
    expect(pickQuality({ renderer: null, fps: null })).toBe("medio");
  });
});
