import * as THREE from "three";
import type { SkinEffect } from "@chalito/protocol";

/**
 * Skins: a material effect over a card's drawing (gold, galaxy, neon…), so one skin fits every
 * roster character with no new art. One ShaderMaterial per card in a single pass (no render
 * targets): it reads the drawing's alpha, so the effect lands on the character's pixels only (plus
 * a thin glow just outside the silhouette for the glowing skins), and keeps the drawing readable:
 * dark line art (outline, eyes, mouth) is left as drawn and the effect follows the drawing's
 * shading. Each skin is its own compile-time variant (a #define), so there is no per-pixel
 * branching. Animate with `uTime` (seconds), driven by the caller's frame loop.
 */
export type SkinId = SkinEffect;

export const SKIN_IDS = [
  "gold",
  "galaxy",
  "neon",
  "crystal",
  "holo",
  "shadow",
  "pixel",
] as const satisfies readonly SkinId[];

const VARIANT: Record<SkinId, number> = { gold: 1, galaxy: 2, neon: 3, crystal: 4, holo: 5, shadow: 6, pixel: 7 };

export const isSkinId = (v: unknown): v is SkinId => typeof v === "string" && Object.hasOwn(VARIANT, v);

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D map;
uniform float uTime;
uniform float uOpacity;
/** The card's height ÷ width (so patterns aren't stretched). */
uniform float uAspect;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
/** Perceptual-ish lightness of a linear colour (0 = ink, 1 = white). */
float lightness(vec3 c) {
  return sqrt(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0));
}

/**
 * The silhouette's edges from 8 alpha taps at radius r (in uv): x = inner rim (inside, near the
 * edge), y = outer glow (outside, near the edge).
 */
vec2 edges(vec2 uv, float a, float r) {
  vec2 d = vec2(r, r / uAspect);
  float mn = 1.0;
  float mx = 0.0;
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.78539816;
    float s = texture2D(map, uv + vec2(cos(ang), sin(ang)) * d).a;
    mn = min(mn, s);
    mx = max(mx, s);
  }
  return vec2(a * (1.0 - mn), (1.0 - a) * mx);
}

void main() {
  vec2 uv = vUv;
  // Card space with square cells: x 0..1 across, y 0..aspect down the card.
  vec2 p = vec2(uv.x, uv.y * uAspect);
  float t = uTime;

#if SKIN == 7
  // Pixel: a coarse grid, hard alpha and a posterized palette.
  vec2 cells = vec2(56.0, floor(56.0 * uAspect));
  uv = (floor(uv * cells) + 0.5) / cells;
#endif

  vec4 tex = texture2D(map, uv);
  vec3 c = tex.rgb;
  float a = tex.a;
  float L = lightness(c);
  // 1 on line art (outline, pupils, mouth): drawn as is, so the character stays readable.
  float ink = 1.0 - smoothstep(0.16, 0.36, L);
  vec3 col = c;
  float outA = a;

#if SKIN == 1
  // Gold: the drawing's shading mapped onto a gold ramp, with a sheen sweeping across.
  vec3 gold = mix(vec3(0.16, 0.06, 0.005), vec3(0.95, 0.55, 0.08), smoothstep(0.15, 0.7, L));
  gold = mix(gold, vec3(1.0, 0.86, 0.45), smoothstep(0.82, 1.0, L));
  float band = fract((uv.x * 0.8 - p.y * 0.45) * 0.9 - t * 0.22);
  float sheen = smoothstep(0.05, 0.0, abs(band - 0.5)) * 0.8 + smoothstep(0.16, 0.0, abs(band - 0.5)) * 0.2;
  vec3 skin = mix(c, gold, 0.9) + vec3(1.0, 0.85, 0.5) * sheen;
  col = mix(skin, c, ink * 0.9);
#elif SKIN == 2
  // Galaxy: a drifting nebula and twinkling stars inside the silhouette, a faint blue rim.
  vec2 q = p * 3.0 + vec2(t * 0.03, -t * 0.02);
  float n = noise(q) * 0.55 + noise(q * 2.1 + 7.3) * 0.3 + noise(q * 4.3 - 3.1) * 0.15;
  vec3 neb = mix(vec3(0.015, 0.01, 0.07), vec3(0.20, 0.05, 0.40), smoothstep(0.25, 0.7, n));
  neb = mix(neb, vec3(0.75, 0.15, 0.55), smoothstep(0.62, 0.9, n));
  neb = mix(neb, vec3(0.08, 0.35, 0.80), smoothstep(0.55, 0.9, noise(q * 1.3 + 19.0)) * 0.6);
  vec2 cell = floor(p * 70.0);
  float h = hash12(cell);
  vec2 f = fract(p * 70.0) - 0.5;
  float star = step(0.975, h) * smoothstep(0.32, 0.0, length(f)) * (0.55 + 0.45 * sin(t * 3.0 + h * 40.0));
  vec3 skin = neb * (0.55 + 0.9 * L) + vec3(star) * 1.3;
  float rim = edges(uv, a, 0.012).x;
  skin += vec3(0.45, 0.65, 1.0) * rim * 0.7;
  // The face and line art stay legible: lines as drawn, a little of the drawing showing through.
  skin = mix(skin, c, 0.12);
  col = mix(skin, c, ink);
#elif SKIN == 3
  // Neon: saturated colours and a glowing outline whose hue drifts.
  float g = dot(c, vec3(0.333));
  vec3 sat = clamp(mix(vec3(g), c, 1.9) * 1.15, 0.0, 1.0);
  vec2 e = edges(uv, a, 0.018);
  vec3 glow = hsv2rgb(vec3(fract(0.52 + 0.12 * sin(t * 0.8) + p.y * 0.15), 0.85, 1.0));
  col = mix(sat, c, ink * 0.6) + glow * e.x * 1.1;
  float pulse = 0.75 + 0.25 * sin(t * 2.4);
  col = mix(col, glow, e.y);
  outA = max(a, e.y * 0.85 * pulse);
#elif SKIN == 4
  // Crystal / ice: pale blue, a slightly refracted look, facets catching the light.
  vec2 wob = vec2(sin(p.y * 40.0 + t * 1.3), cos(p.x * 36.0 - t * 1.1)) * 0.0025;
  vec3 r = texture2D(map, uv + wob).rgb;
  float Lr = lightness(r);
  vec3 ice = mix(vec3(0.22, 0.45, 0.72), vec3(0.80, 0.93, 1.0), smoothstep(0.25, 0.95, Lr));
  // Soft facets (cells of a coarse noise) and one glint sweeping across.
  float facet = (noise(floor(p * 9.0) + 3.7) - 0.5) * 0.18;
  float glint = smoothstep(0.06, 0.0, abs(fract(uv.x * 0.7 + p.y * 0.5 - t * 0.18) - 0.5)) * 0.55;
  float rim = edges(uv, a, 0.014).x;
  vec3 skin = mix(c, ice, 0.78) + facet + vec3(0.85, 0.95, 1.0) * (glint + rim * 0.7);
  col = mix(skin, c, ink * 0.85);
#elif SKIN == 5
  // Holographic: iridescent hue that shifts with position, shading and time.
  float hue = fract(uv.x * 0.6 + p.y * 0.9 + L * 0.35 + t * 0.12);
  vec3 rainbow = hsv2rgb(vec3(hue, 0.7, 1.0));
  float shine = pow(abs(sin((uv.x + p.y) * 6.0 - t * 1.5)), 12.0) * 0.35;
  vec3 skin = c * 0.4 + rainbow * (0.3 + 0.5 * L) + vec3(shine);
  col = mix(skin, c, ink * 0.8);
#elif SKIN == 6
  // Shadow: a dark silhouette with a pulsing purple glow; the eyes and highlights still read.
  vec3 dark = vec3(0.05, 0.03, 0.09) + c * vec3(0.20, 0.16, 0.30);
  dark = mix(dark, vec3(0.85, 0.75, 1.0), smoothstep(0.82, 0.97, L) * 0.85);
  vec2 e = edges(uv, a, 0.02);
  float pulse = 0.7 + 0.3 * sin(t * 1.8);
  vec3 purple = vec3(0.62, 0.25, 1.0);
  col = dark + purple * e.x * 0.9 * pulse;
  col = mix(col, purple, e.y);
  outA = max(a, e.y * 0.8 * pulse);
#elif SKIN == 7
  vec3 levels = vec3(5.0);
  col = floor(pow(c, vec3(1.0 / 2.2)) * levels + 0.5) / levels;
  col = pow(col, vec3(2.2));
  outA = step(0.5, a);
#endif

  gl_FragColor = vec4(col, outA * uOpacity);
  if (gl_FragColor.a < 0.003) discard;
  #include <colorspace_fragment>
}
`;

export interface SkinMaterial extends THREE.ShaderMaterial {
  uniforms: {
    map: { value: THREE.Texture | null };
    uTime: { value: number };
    uOpacity: { value: number };
    uAspect: { value: number };
  };
}

/** The skin's material for a card's body plane (`aspect` = the card's height ÷ width). */
export const createSkinMaterial = (
  skin: SkinId,
  map: THREE.Texture | null,
  aspect: number,
  opacity = 1,
): SkinMaterial => {
  const m = new THREE.ShaderMaterial({
    name: `skin:${skin}`,
    defines: { SKIN: VARIANT[skin] },
    uniforms: {
      map: { value: map },
      uTime: { value: 0 },
      uOpacity: { value: opacity },
      uAspect: { value: aspect },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
  });
  return m as SkinMaterial;
};
