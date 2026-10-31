/**
 * The edge of the terrain shown. A window is a rectangle of the atlas, but the terrain doesn't end
 * in one: it dissolves over the outer WINDOW_MARGIN of the window, along an outline with rounded
 * corners, frayed by fractal noise and by the relief, so ridges reach further out than the valleys
 * between them. Every route a window shows lies at least WINDOW_MARGIN inside it (`covers`), so the
 * ground under the selected route is never faded.
 *
 * `EDGE_GLSL` and `edgeMask` are the same function, for the shaders and for the label layer.
 *
 * Within it, the terrain of the page's area is whole; beyond the area's border it recedes, as the
 * rest of the country does in the region browser (`AREA_GLSL`). Around the window lies the area's
 * coarse relief, which dissolves at its own edge the same way and fills in where the window's
 * dissolves (`LAYER_GLSL`).
 */
import { WINDOW_MARGIN } from '../data/tiles';

/** Radius (m) the window's corners are rounded to. */
export const CORNER = 2000;
/** Width (m) over which the terrain fades out. */
export const FADE = 500;
/** How far (m) noise and the relief move the outline in and out: ridges reach out, valleys recede. */
export const FRAY = 500;
export const RELIEF = 250;
/** Wavelength (m) of the noise's coarsest octave. */
const GRAIN = 2600;
/** Summed octaves of value noise keep near their mean; this stretches them over the whole of `FRAY`. */
const CONTRAST = 1.8;
/** Where the outline can reach in from the window's edge (m): beyond it, the terrain is whole. */
export const REACH = FADE + 2 * (FRAY + RELIEF);

if (CORNER > WINDOW_MARGIN || REACH > WINDOW_MARGIN) throw new Error('the terrain edge must stay within WINDOW_MARGIN');

const f = (v: number) => v.toFixed(1);

/**
 * GLSL for `edgeMask(xz, alt, size, altRange)`: 0 beyond the terrain's edge, 1 where it is whole.
 * `xz` is in world space (m from the window's centre), `size` the window's and `altRange` its lowest
 * and highest altitude. Integers wrap at 32 bits in GLSL ES 3.00, as `Math.imul` does.
 */
export const EDGE_GLSL = `
float edgeHash(ivec2 c) {
  int n = c.x * 1619 + c.y * 31337;
  n = (n << 13) ^ n; n = n * (n * n * 15731 + 789221) + 1376312589;
  return float(n & 0x7fffffff) / 2147483647.0;
}
float edgeNoise(vec2 p) {
  ivec2 c = ivec2(floor(p)); vec2 t = fract(p), u = t * t * (3.0 - 2.0 * t);
  return mix(mix(edgeHash(c), edgeHash(c + ivec2(1, 0)), u.x), mix(edgeHash(c + ivec2(0, 1)), edgeHash(c + ivec2(1, 1)), u.x), u.y);
}
float edgeMask(vec2 xz, float alt, vec2 size, vec2 altRange) {
  vec2 q = abs(xz) - (size * 0.5 - ${f(CORNER)});
  float inside = ${f(CORNER)} - length(max(q, 0.0)) - min(max(q.x, q.y), 0.0);
  if (inside >= ${f(REACH)}) return 1.0;
  vec2 p = xz / ${f(GRAIN)};
  float fray = clamp(((edgeNoise(p) * 4.0 + edgeNoise(p * 2.0 + 17.3) * 2.0 + edgeNoise(p * 4.0 + 41.7)) / 7.0 * 2.0 - 1.0) * ${f(CONTRAST)}, -1.0, 1.0);
  float relief = clamp((alt - altRange.x) / max(altRange.y - altRange.x, 1.0), 0.0, 1.0) * 2.0 - 1.0;
  return smoothstep(0.0, ${f(FADE)}, inside - ${f(FRAY + RELIEF)} + fray * ${f(FRAY)} + relief * ${f(RELIEF)});
}
`;

/** Cell (m) of the area's mask: its border is simplified to 150 m (`traceArcs`). */
export const AREA_CELL = 100;
/** How much of the terrain beyond the area's border is drawn: points, contours and trails thin out or dim to it. */
export const OUTSIDE = 0.3;

/**
 * GLSL for `areaKeep(xz)`: how much of the terrain to draw at world `xz`, 1 in the page's area and
 * `OUTSIDE` beyond it, blended over a cell. `uArea` is the area rasterised (`rasterizeRings`, row 0
 * at the north edge) over the world rectangle `uAreaRect` (north-west corner xy, size zw): the
 * window and the area's relief.
 */
export const AREA_GLSL = `
uniform sampler2D uArea; uniform vec4 uAreaRect;
float areaKeep(vec2 xz) { return mix(${f(OUTSIDE)}, 1.0, textureLod(uArea, (xz - uAreaRect.xy) / uAreaRect.zw, 0.0).r); }
`;

/**
 * GLSL for `layerEdge(xz, alt)`, after `EDGE_GLSL`: how whole a terrain layer is at world `xz`. It
 * dissolves at the edge of its rectangle `uRect` (centre xy, size zw), with `uRectAlt` its lowest
 * and highest altitude. Where it lies under a finer layer, `uHole` (size 0: none) with `uHoleAlt`,
 * it gives way as that one dissolves, so the two cross-fade: the area's relief under the window.
 */
export const LAYER_GLSL = `
uniform vec4 uRect, uHole; uniform vec2 uRectAlt, uHoleAlt;
float layerEdge(vec2 xz, float alt) {
  float e = edgeMask(xz - uRect.xy, alt, uRect.zw, uRectAlt);
  return uHole.z > 0.0 ? e * (1.0 - edgeMask(xz - uHole.xy, alt, uHole.zw, uHoleAlt)) : e;
}
`;

function hash(x: number, y: number): number {
  let n = (Math.imul(x, 1619) + Math.imul(y, 31337)) | 0;
  n = (n << 13) ^ n;
  n = (Math.imul(n, (Math.imul(Math.imul(n, n), 15731) + 789221) | 0) + 1376312589) | 0;
  return (n & 0x7fffffff) / 2147483647;
}

function noise(x: number, y: number): number {
  const i = Math.floor(x), j = Math.floor(y), s = x - i, t = y - j;
  const u = s * s * (3 - 2 * s), v = t * t * (3 - 2 * t);
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  return lerp(lerp(hash(i, j), hash(i + 1, j), u), lerp(hash(i, j + 1), hash(i + 1, j + 1), u), v);
}

/** `edgeMask` of `EDGE_GLSL`: how whole the terrain is at world (x, z) and altitude `alt`, 0–1. */
export function edgeMask(x: number, z: number, alt: number, [w, h]: [number, number], [lo, hi]: [number, number]): number {
  const qx = Math.abs(x) - (w / 2 - CORNER), qz = Math.abs(z) - (h / 2 - CORNER);
  const inside = CORNER - Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) - Math.min(Math.max(qx, qz), 0);
  if (inside >= REACH) return 1;
  const px = x / GRAIN, pz = z / GRAIN;
  const fray = Math.min(1, Math.max(-1, (((noise(px, pz) * 4 + noise(px * 2 + 17.3, pz * 2 + 17.3) * 2 + noise(px * 4 + 41.7, pz * 4 + 41.7)) / 7) * 2 - 1) * CONTRAST));
  const relief = Math.min(1, Math.max(0, (alt - lo) / Math.max(hi - lo, 1))) * 2 - 1;
  const k = Math.min(1, Math.max(0, (inside - FRAY - RELIEF + fray * FRAY + relief * RELIEF) / FADE));
  return k * k * (3 - 2 * k);
}
