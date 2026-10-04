/** Render quality slider (brief §5 M11). The values mirror packages/config/render.yaml (a test keeps them equal). */
export type RenderQuality = "auto" | "bajo" | "medio" | "alto";
export type QualityLevel = Exclude<RenderQuality, "auto">;

export interface LevelSettings {
  fpsCap: number;
  shadows: boolean;
  /** Flat billboards, no gesture rig: the cheapest way to draw a companion. */
  impostors: boolean;
  pixelRatioMax: number;
}

export interface RenderSettings {
  default: RenderQuality;
  levels: Record<QualityLevel, LevelSettings>;
  auto: { probeSeconds: number; downgradeBelowFps: number };
}

export const RENDER_DEFAULTS: RenderSettings = {
  default: "auto",
  levels: {
    bajo: { fpsCap: 30, shadows: false, impostors: true, pixelRatioMax: 1.0 },
    medio: { fpsCap: 45, shadows: false, impostors: false, pixelRatioMax: 1.5 },
    alto: { fpsCap: 60, shadows: true, impostors: false, pixelRatioMax: 2.0 },
  },
  auto: { probeSeconds: 3, downgradeBelowFps: 40 },
};

/** Software GL (SwiftShader, llvmpipe, Microsoft Basic Render): straight to bajo, no probe needed. */
export const isSoftwareRenderer = (renderer: string | null): boolean =>
  !!renderer && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);

/**
 * What "auto" settles on: bajo on a software renderer or below the downgrade threshold, alto when
 * the probe (drawn at alto) kept near its cap, medio otherwise.
 */
export const pickQuality = (
  probe: { renderer: string | null; fps: number | null },
  cfg: RenderSettings = RENDER_DEFAULTS,
): QualityLevel => {
  if (isSoftwareRenderer(probe.renderer)) return "bajo";
  if (probe.fps === null) return "medio";
  if (probe.fps < cfg.auto.downgradeBelowFps) return "bajo";
  return probe.fps >= cfg.levels.alto.fpsCap * 0.9 ? "alto" : "medio";
};
