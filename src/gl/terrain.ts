import type { Relief, RouteView, TerrainWindow } from '../data/load';
import type { BBox } from '../data/types';
import { createProgram, createVao, deleteVao, fitCanvas, type Mat4, type Program } from './glkit';
import { OrbitCamera, type Pose } from './camera';
import type { Resolved } from '../theme/tokens';
import { OFF_NETWORK } from '../data/types';
import { TrailNetwork } from '../geo/network';
import { clipRings, rasterizeRings, smoothRing } from '../data/shapes';
import { AREA_CELL, AREA_GLSL, EDGE_GLSL, edgeMask, LAYER_GLSL } from './edge';

// One layer of terrain as a point cloud: the window at 20 m, or the area's relief around it. uStep
// is the spacing of its points in cells (2 thins the window out far away, 0.5 fills in the relief),
// uCorner the world position of its grid's north-west corner.
const POINTS_VS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uH;
uniform ivec2 uGrid; uniform float uStep, uCell; uniform vec2 uCorner;
uniform mat4 uVP; uniform vec3 uEye; uniform float uExag, uBase, uMinAlt, uMaxAlt;
uniform float uFocus, uAperture, uDpr, uScan, uGain, uPointSize, uViewH;
uniform vec3 uLow, uHigh, uSteep, uScanColor;
out vec3 vColor; out float vAlpha;
${EDGE_GLSL}${LAYER_GLSL}${AREA_GLSL}
float hash(int n) { n = (n << 13) ^ n; n = n * (n * n * 15731 + 789221) + 1376312589; return float(n & 0x7fffffff) / 2147483647.0; }
float H(ivec2 c) { c = clamp(c, ivec2(0), uGrid - 1); return float(texelFetch(uH, c, 0).r) * 0.1; }

void main() {
  int cols = int(ceil(float(uGrid.x) / uStep));
  int id = gl_VertexID;
  // Jitter each point inside its cell so the regular grid never shows as moiré.
  vec2 g = (vec2(float(id % cols), float(id / cols)) + vec2(hash(id * 2), hash(id * 2 + 1))) * uStep;
  ivec2 c0 = ivec2(floor(g)); vec2 f = fract(g);
  float h00 = H(c0), h10 = H(c0 + ivec2(1, 0)), h01 = H(c0 + ivec2(0, 1)), h11 = H(c0 + ivec2(1, 1));
  if (min(min(h00, h10), min(h01, h11)) <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float alt = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  float dx = (h10 - h00 + h11 - h01) * 0.5 / uCell, dz = (h01 - h00 + h11 - h10) * 0.5 / uCell;
  vec3 n = normalize(vec3(-dx * uExag, 1.0, -dz * uExag));
  vec3 world = vec3(uCorner.x + (g.x + 0.5) * uCell, (alt - uBase) * uExag, uCorner.y + (g.y + 0.5) * uCell);
  // Towards the layer's edge (src/gl/edge.ts) the points thin out, so it dissolves rather than
  // ends; beyond the page's area they thin out and dim, so the area stands out.
  float edge = layerEdge(world.xz, alt), keep = areaKeep(world.xz);
  if (edge * keep < hash(~id)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  gl_Position = uVP * vec4(world, 1.0);

  // Depth of field: the circle of confusion grows away from the focus distance; energy is conserved.
  float dist = distance(world, uEye);
  float coc = abs(dist - uFocus) / dist * uAperture * uViewH;
  float size = uPointSize + coc;
  gl_PointSize = clamp(size * uDpr, 1.0, 14.0);
  float energy = (uPointSize * uPointSize) / (size * size);

  float t = clamp((alt - uMinAlt) / (uMaxAlt - uMinAlt), 0.0, 1.0);
  float lam = clamp(dot(n, normalize(vec3(-0.45, 0.75, -0.5))), 0.0, 1.0);
  float steep = clamp(length(vec2(dx, dz)) * 1.4, 0.0, 1.0);
  vec3 col = mix(uLow, uHigh, pow(t, 0.75)) * (0.3 + 0.95 * lam) + uSteep * steep * 0.5;
  float scan = exp(-pow((alt - uScan) / 5.0, 2.0));
  vColor = max(col + uScanColor * scan * 1.4, 0.0);
  // Far terrain piles up at grazing angles; fade it so the foreground keeps its relief.
  float far = mix(1.0, 0.3, smoothstep(uFocus * 0.9, uFocus * 2.4, dist));
  vAlpha = (uGain * (0.5 + 0.5 * lam) + scan * 0.5) * energy * far * mix(0.4, 1.0, edge) * sqrt(keep);
}`;

const POINTS_FS = `#version 300 es
precision mediump float;
in vec3 vColor; in float vAlpha; out vec4 o;
void main() {
  vec2 p = gl_PointCoord - 0.5; float d = dot(p, p);
  if (d > 0.25) discard;
  float a = vAlpha * (1.0 - d * 4.0);
  o = vec4(vColor * a, a);
}`;

// A layer's contours, which dissolve with it.
const CONTOURS_VS = `#version 300 es
precision highp float;
in vec3 aPos; in float aWeight;
uniform mat4 uVP; uniform vec2 uCorner; uniform float uCell, uExag, uBase;
out float vWeight; out float vAlt; out float vKeep;
${EDGE_GLSL}${LAYER_GLSL}${AREA_GLSL}
void main() {
  // Vertices are in grid units: (column, altitude, row).
  vec3 p = vec3(uCorner.x + (aPos.x + 0.5) * uCell, aPos.y, uCorner.y + (aPos.z + 0.5) * uCell);
  gl_Position = uVP * vec4(p.x, (p.y - uBase) * uExag, p.z, 1.0);
  vWeight = aWeight; vAlt = p.y; vKeep = layerEdge(p.xz, p.y) * areaKeep(p.xz);
}`;

const CONTOURS_FS = `#version 300 es
precision mediump float;
in float vWeight; in float vAlt; in float vKeep; out vec4 o;
uniform vec3 uColor; uniform float uAlpha, uScan;
void main() { // minor / major
  float a = uAlpha * mix(0.35, 1.0, vWeight) * (1.0 + exp(-pow((vAlt - uScan) / 12.0, 2.0)) * 2.0) * vKeep;
  o = vec4(uColor * a, a);
}`;

// The trail network: one instance per segment, extruded to a quad in screen space so lines keep
// their width at any DPR (GL_LINES is 1 device pixel everywhere). aNear is the walking distance
// from the selected route at A and B, aPrev the same from the route selected before it.
const NETWORK_VS = `#version 300 es
precision highp float;
in vec3 aA; in vec3 aB; in float aClass; in vec2 aNear; in vec2 aPrev;
uniform mat4 uVP; uniform vec2 uViewport, uSize, uAlt; uniform vec3 uEye; uniform float uHalf, uExag, uBase, uFocus;
out float vSide; out float vClass; out float vFade; out float vAlong; out float vKeep;
flat out vec2 vNear; flat out vec2 vPrev; flat out float vLen;
${EDGE_GLSL}${AREA_GLSL}
const vec2 CORNER[6] = vec2[6](vec2(0, -1), vec2(1, -1), vec2(0, 1), vec2(0, 1), vec2(1, -1), vec2(1, 1));
void main() {
  vec2 k = CORNER[gl_VertexID];
  vec3 wa = vec3(aA.x, (aA.y - uBase) * uExag, aA.z), wb = vec3(aB.x, (aB.y - uBase) * uExag, aB.z);
  vec4 a = uVP * vec4(wa, 1.0), b = uVP * vec4(wb, 1.0);
  if (a.w <= 0.0 || b.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 dir = normalize((b.xy / b.w - a.xy / a.w) * uViewport + vec2(1e-5)), nrm = vec2(-dir.y, dir.x);
  vec4 p = k.x < 0.5 ? a : b;
  // One pixel beyond the half-width on each side, for the antialiased edge.
  p.xy += nrm * k.y * (uHalf + 1.0) / uViewport * p.w;
  gl_Position = p;
  vSide = k.y; vClass = aClass;
  vAlong = k.x; vNear = aNear; vPrev = aPrev; vLen = distance(aA.xz, aB.xz);
  vFade = mix(1.0, 0.35, smoothstep(uFocus * 0.9, uFocus * 2.4, distance(k.x < 0.5 ? wa : wb, uEye)));
  // Trails beyond the page's area dim less than the terrain: their junctions are still the way on.
  vec3 end = k.x < 0.5 ? aA : aB;
  vKeep = edgeMask(end.xz, end.y, uSize, uAlt) * sqrt(areaKeep(end.xz));
}`;

// With uAdjacent the network fades out over uReach (m) of walking distance from the selected route,
// and loads: it is drawn out to uFront, the head of the load in uHead. The trails of the route
// before fade out (uOut) as far as they had loaded (uPrevFront).
const NETWORK_FS = `#version 300 es
precision highp float; // uHalf is shared with the vertex shader, so precisions must match
in float vSide; in float vClass; in float vFade; in float vAlong; in float vKeep; flat in vec2 vNear; flat in vec2 vPrev; flat in float vLen; out vec4 o;
uniform vec3 uColors[3]; uniform vec3 uCasing, uHead; uniform float uHalf, uAlpha; uniform int uPass;
uniform vec2 uReach; uniform float uAdjacent, uFront, uPrevFront, uOut, uEdge, uHeadLen;
// Walking distance here, from whichever end of the segment is nearer along the trails.
float walk(vec2 d) { return min(d.x + vAlong * vLen, d.y + (1.0 - vAlong) * vLen); }
float shownTo(float d, float front) { return (1.0 - smoothstep(uReach.x, uReach.y, d)) * (1.0 - smoothstep(front - uEdge, front, d)); }
void main() {
  float cover = clamp(uHalf + 0.5 - abs(vSide) * (uHalf + 1.0), 0.0, 1.0);
  float d = walk(vNear), now = shownTo(d, uFront);
  float shown = mix(1.0, max(now, shownTo(walk(vPrev), uPrevFront) * uOut), uAdjacent);
  // Just behind the front, dimming with the reach as it travels out.
  float head = uPass == 0 ? 0.0 : uAdjacent * now * exp(-pow((uFront - d) / uHeadLen, 2.0));
  vec3 c = uPass == 0 ? uCasing : mix(uColors[int(vClass + 0.5)], uHead, head);
  float a = mix(uAlpha, 1.0, head) * cover * vFade * shown * vKeep;
  o = vec4(c * a, a);
}`;

// The page's area border, draped on the terrain: one instance per segment, a screen-space quad like
// the network's, dissolving where the terrain does: at the window's edge, or beyond it at the edge
// of the area's relief (uRect, size 0 without one).
const BORDER_VS = `#version 300 es
precision highp float;
in vec3 aA; in vec3 aB;
uniform mat4 uVP; uniform vec2 uViewport, uSize, uAlt, uRectAlt; uniform vec4 uRect; uniform float uHalf, uExag, uBase;
out float vSide; out float vEdge;
${EDGE_GLSL}
const vec2 CORNER[6] = vec2[6](vec2(0, -1), vec2(1, -1), vec2(0, 1), vec2(0, 1), vec2(1, -1), vec2(1, 1));
void main() {
  vec2 k = CORNER[gl_VertexID];
  vec4 a = uVP * vec4(aA.x, (aA.y - uBase) * uExag, aA.z, 1.0), b = uVP * vec4(aB.x, (aB.y - uBase) * uExag, aB.z, 1.0);
  if (a.w <= 0.0 || b.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 dir = normalize((b.xy / b.w - a.xy / a.w) * uViewport + vec2(1e-5)), nrm = vec2(-dir.y, dir.x);
  vec4 p = k.x < 0.5 ? a : b;
  p.xy += nrm * k.y * (uHalf + 1.0) / uViewport * p.w;
  gl_Position = p;
  vec3 end = k.x < 0.5 ? aA : aB;
  vSide = k.y; vEdge = edgeMask(end.xz, end.y, uSize, uAlt);
  if (uRect.z > 0.0) vEdge = max(vEdge, edgeMask(end.xz - uRect.xy, end.y, uRect.zw, uRectAlt));
}`;

const BORDER_FS = `#version 300 es
precision highp float; // uHalf is shared with the vertex shader, so precisions must match
in float vSide; in float vEdge; out vec4 o;
uniform vec3 uColor; uniform float uHalf, uAlpha;
void main() {
  float a = uAlpha * clamp(uHalf + 0.5 - abs(vSide) * (uHalf + 1.0), 0.0, 1.0) * vEdge;
  o = vec4(uColor * a, a);
}`;

// A route: one instance per segment, drawn as a screen-space capsule (a segment with round ends),
// so consecutive segments meet in clean round joins. The quad is laid out in pixels with w = 1,
// so vPos interpolates linearly on screen.
const RIBBON_VS = `#version 300 es
precision highp float;
in vec3 aA; in vec3 aB; in float aClass;
uniform mat4 uVP; uniform vec2 uViewport; uniform float uHalf, uExag, uBase;
out vec2 vPos; out float vLen; flat out int vClass;
const vec2 CORNER[6] = vec2[6](vec2(0, -1), vec2(1, -1), vec2(0, 1), vec2(0, 1), vec2(1, -1), vec2(1, 1));
void main() {
  vec2 k = CORNER[gl_VertexID];
  vec4 a = uVP * vec4(aA.x, (aA.y - uBase) * uExag, aA.z, 1.0), b = uVP * vec4(aB.x, (aB.y - uBase) * uExag, aB.z, 1.0);
  if (a.w <= 0.0 || b.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 sa = a.xy / a.w * uViewport, sb = b.xy / b.w * uViewport;
  float len = length(sb - sa);
  vec2 dir = len > 1e-4 ? (sb - sa) / len : vec2(1.0, 0.0), nrm = vec2(-dir.y, dir.x);
  // Pixels along the segment from A and across it, reaching one pixel beyond the half-width
  // (and beyond each end, for the round cap) for the antialiased edge.
  float r = uHalf + 1.0;
  vPos = vec2(k.x * len + (k.x * 2.0 - 1.0) * r, k.y * r);
  gl_Position = vec4((sa + dir * vPos.x + nrm * vPos.y) / uViewport, 0.0, 1.0);
  vLen = len; vClass = int(aClass + 0.5);
}`;

// Flat colour: a lighter centre line read as a neon glow, which the owner did not want.
const RIBBON_FS = `#version 300 es
precision highp float; // uHalf is shared with the vertex shader, so precisions must match
in vec2 vPos; in float vLen; flat in int vClass; out vec4 o;
// uByClass colours each segment by its trail class (uClasses[3] = off-network) instead of uColor.
uniform vec3 uColor; uniform vec3 uClasses[4]; uniform bool uByClass; uniform float uHalf;
void main() {
  float t = clamp(vPos.x / max(vLen, 1e-4), 0.0, 1.0);
  float d = length(vec2(vPos.x - t * vLen, vPos.y));
  float cover = clamp(uHalf + 0.5 - d, 0.0, 1.0);
  if (cover <= 0.0) discard;
  // Segments are often shorter than the ribbon is wide, so caps pile up; the depth test keeps the
  // nearest segment at each pixel, so overlapping antialiased edges don't double up.
  gl_FragDepth = d / (uHalf + 1.5);
  o = vec4((uByClass ? uClasses[vClass] : uColor) * cover, cover);
}`;


/** Which trails of the network are drawn: 'auto' those branching off the selected route (see `NETWORK_REACH`), 'all' every one, 'off' none. */
export type TrailMode = 'auto' | 'all' | 'off';

/** Walking distances (m) from the selected route in 'auto': trails are fully shown within the first and hidden beyond the second. */
const NETWORK_REACH = [300, 5000];
/**
 * A newly selected route loads those trails: a front runs out along them to the end of the reach in
 * `LOAD` seconds, with a soft edge of `LOAD_EDGE` m and a head of about `LOAD_HEAD` m in the accent.
 * The trails of the route before fade out over `UNLOAD` seconds.
 */
const LOAD = 1.8;
const LOAD_EDGE = 40;
const LOAD_HEAD = 200;
const UNLOAD = 0.4;

/** Spacing (m) of the points the area's border is draped on the terrain with; its arcs are simplified to 150 m. */
const BORDER_STEP = 40;
/**
 * Camera distances (m) beyond which the window's points thin out to every 2nd and every 4th cell,
 * as many would share a pixel, with the brightness of each (`GAIN`).
 */
const THIN = [16000, 40000];
const GAIN = [0.6, 0.9, 1.2];
/**
 * The area's relief has its points as far apart as the window's, but no closer than half its cell
 * (50 m); where they are sparser, each is brighter by the ground it stands for, up to `RELIEF_GAIN`
 * times, so the two layers meet at about the same light.
 */
const RELIEF_GAIN = 2.5;

/** Camera distances (m) over which route ribbons narrow to `RIBBON_FAR` of their width, so they don't swamp the overview. */
const RIBBON_SHRINK = [4000, 16000];
const RIBBON_FAR = 0.55;
/** Likewise for the 2D map markers (hiker, waypoint pins and rings), over the whole zoom range. */
const MARKER_SHRINK = [4000, 40000];
const MARKER_FAR = 0.45;

/** Scale factor that eases (smoothstep) from 1 at camera distance `near` down to `floor` at `far`. */
export function zoomScale(dist: number, [near, far]: number[], floor: number): number {
  const s = Math.min(1, Math.max(0, (dist - near) / (far - near)));
  return 1 - (1 - floor) * s * s * (3 - 2 * s);
}

/** `markers` scales the 2D map markers with the zoom, see `MARKER_SHRINK`. */
export interface RenderInfo { vp: Mat4; width: number; height: number; eye: number[]; focus: number; scanAlt: number; fps: number; points: number; markers: number }

/** `count` is the number of segments (instances). */
interface Ribbon { vao: WebGLVertexArrayObject; count: number }
/** `count` is the number of line vertices. */
interface Contours { vao: WebGLVertexArrayObject; count: number }

/**
 * Bilinear height (m) at (x, y) metres east and south of a grid's north-west corner, clamped to the
 * grid, over the corners that have data (0 is none): NaN where none has.
 */
function sampleGrid(h: Uint16Array, cols: number, rows: number, cell: number, x: number, y: number): number {
  const gx = Math.min(cols - 1.001, Math.max(0, x / cell - 0.5)), gy = Math.min(rows - 1.001, Math.max(0, y / cell - 0.5));
  const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
  let sum = 0, weight = 0;
  for (const [a, b, w] of [[i, j, (1 - fx) * (1 - fy)], [i + 1, j, fx * (1 - fy)], [i, j + 1, (1 - fx) * fy], [i + 1, j + 1, fx * fy]]) {
    const v = h[b * cols + a];
    if (v) { sum += v * 0.1 * w; weight += w; }
  }
  return weight > 0 ? sum / weight : NaN;
}

/**
 * The 3D terrain console: a jittered point cloud of swissALTI3D heights, contour lines, the
 * full hiking network and the selected route as a screen-space ribbon. No depth test: every
 * layer is additive or blended on top, as on a hologram table.
 *
 * It shows one window of the atlas at a time (`load` swaps it in place), within the area's coarse
 * relief (`setRelief`). Its methods take LV95 coordinates; world space has its origin at the
 * window's centre (see AGENTS.md).
 */
export class TerrainView {
  readonly camera = new OrbitCamera(1200, 100000);
  readonly gl: WebGL2RenderingContext;
  exaggeration = 1.5;
  trailMode: TrailMode = 'auto';
  private points: Program;
  private lines: Program;
  private trails: Program;
  private ribbon: Program;
  private outline: Program;
  private heightTex: WebGLTexture;
  /**
   * The page's area over `areaBox` (`AREA_GLSL`): the window and the relief around it. Its border
   * there, draped.
   */
  private areaTex: WebGLTexture;
  private areaBox!: BBox;
  private border: { vao: WebGLVertexArrayObject; count: number } | null = null;
  /** The page's area as flat LV95 rings, smoothed (`setArea`); null shows the whole window as the area. */
  area: number[][] | null = null;
  private contours: Contours | null = null;
  private contourWorker: Worker | null = null;
  /** The area's relief around the window (`setRelief`), its height texture and contours, and the worker tracing them. */
  private relief: { data: Relief; tex: WebGLTexture; contours: Contours | null; worker: Worker | null } | null = null;
  /**
   * `count` is the number of segments (instances), `first` the line vertex each one starts at,
   * `near` and `prev` the buffers of `aNear` and `aPrev`, and `nearD` what `near` holds.
   */
  private network!: { vao: WebGLVertexArrayObject; count: number; first: Uint32Array; near: WebGLBuffer; prev: WebGLBuffer; nearD: Float32Array };
  private walk!: TrailNetwork;
  /** The route `aNear` was computed for, seconds into loading its trails and into fading out those of the route before. */
  private reachRoute: string | null = null;
  private loadT = LOAD;
  private unloadT = UNLOAD;
  /** How far the route before had loaded when it was replaced. */
  private prevFront = 0;
  /** The trail mode of the last frame: switching to 'auto' loads the trails again. */
  private drawnMode: TrailMode = 'auto';
  /** Under `prefers-reduced-motion` the trails don't load or fade out, they are there at once. */
  private still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private selectedRoute: RouteView | null = null;
  private hoveredRoute: RouteView | null = null;
  private selected: Ribbon | null = null;
  private hovered: Ribbon | null = null;
  /** Built once per route view and window: hovering the map swaps the hover ribbon often. */
  private ribbons = new Map<RouteView, Ribbon>();
  private emptyVao: WebGLVertexArrayObject;
  private fps = { frames: 0, since: 0, value: 0 };
  /** The window shown. */
  win!: TerrainWindow;
  /** Its width and height (m), and its lowest point, where the vertical exaggeration starts. */
  size: [number, number] = [0, 0];
  base = 0;
  /** Colours and blending of the current display (src/theme); reassigned on every scheme change. */
  palette!: Resolved['gl'];

  constructor(readonly canvas: HTMLCanvasElement, win: TerrainWindow) {
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.points = createProgram(gl, POINTS_VS, POINTS_FS);
    this.lines = createProgram(gl, CONTOURS_VS, CONTOURS_FS);
    this.trails = createProgram(gl, NETWORK_VS, NETWORK_FS);
    this.ribbon = createProgram(gl, RIBBON_VS, RIBBON_FS);
    this.outline = createProgram(gl, BORDER_VS, BORDER_FS);
    this.emptyVao = gl.createVertexArray()!;
    this.heightTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    // Linear: the area blends into its surroundings over a cell rather than in steps.
    this.areaTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.areaTex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    this.load(win);
    Object.assign(this.camera, this.home());
  }

  /**
   * The overview: of the whole area's relief, or without one of the window, from the south-west,
   * looking at a quarter of its height.
   */
  private home(): Pose {
    const r = this.relief?.data, [lo, hi] = this.altRange();
    const b = r?.bbox ?? this.win.bbox, [x, y, z] = this.world((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, lo + (hi - lo) * 0.25);
    return { target: [x, y, z], az: 2.75, el: 0.6, dist: Math.max(b[2] - b[0], b[3] - b[1]) * (r ? 1 : 1.25) };
  }

  /** The lowest and highest terrain shown (m): the window's, and the relief's around it. */
  altRange(): [number, number] {
    const { grid } = this.win, r = this.relief?.data;
    return r ? [Math.min(grid.minAlt, r.minAlt), Math.max(grid.maxAlt, r.maxAlt)] : [grid.minAlt, grid.maxAlt];
  }

  /**
   * Shows another window. World space keeps its origin at the window's centre, so the camera (its
   * target and any fly-to goal) moves with the origin and stays over the same ground. The home
   * (double-click) becomes the new window's overview.
   */
  load(win: TerrainWindow) {
    const gl = this.gl, { grid, bbox } = win;
    const size: [number, number] = [bbox[2] - bbox[0], bbox[3] - bbox[1]];
    if (this.win) {
      const [w0, s0] = this.win.bbox;
      this.camera.shift([w0 + this.size[0] / 2 - (bbox[0] + size[0] / 2), (this.base - grid.minAlt) * this.exaggeration, bbox[1] + size[1] / 2 - (s0 + this.size[1] / 2)]);
    }
    this.win = win;
    this.size = size;
    this.base = grid.minAlt;
    this.camera.setHome(this.home());

    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, grid.cols, grid.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, win.heights);

    if (this.network) {
      deleteVao(gl, this.network.vao);
      gl.deleteBuffer(this.network.near);
      gl.deleteBuffer(this.network.prev);
    }
    this.walk = new TrailNetwork(win.trails);
    this.network = this.buildNetwork();
    this.buildContours();
    this.buildArea();
    for (const r of this.ribbons.values()) deleteVao(gl, r.vao);
    this.ribbons.clear();
    this.reachRoute = null;
    this.setRoute(this.selectedRoute);
    this.setHover(this.hoveredRoute);
  }

  /**
   * Sets the page's area: beyond its border the terrain recedes, and the border is drawn on it, as
   * the region browser lights the current area. Its corners are cut, as the steps of the raster it
   * was traced on show up close.
   */
  setArea(rings: number[][] | null) {
    this.area = rings && rings.map((ring) => smoothRing(ring, 2));
    this.buildArea();
  }

  /**
   * Sets the area's relief (src/data/load.ts): shown around the window, it fills in where the
   * window's edge dissolves, and the home (double-click) becomes the overview of all of it.
   */
  setRelief(relief: Relief | null) {
    const gl = this.gl;
    if (this.relief) {
      gl.deleteTexture(this.relief.tex);
      this.relief.worker?.terminate();
      if (this.relief.contours) deleteVao(gl, this.relief.contours.vao);
    }
    this.relief = null;
    if (relief) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, relief.cols, relief.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, relief.heights);
      const r: NonNullable<TerrainView['relief']> = { data: relief, tex, contours: null, worker: null };
      r.worker = this.traceContours(relief.heights, relief.cols, relief.rows, (c) => { r.contours = c; r.worker = null; });
      this.relief = r;
    }
    this.camera.setHome(this.home());
    this.buildArea();
  }

  /**
   * The area's mask (`uArea`) over the window and the relief around it, and its border there,
   * draped on the terrain.
   */
  private buildArea() {
    const gl = this.gl, r = this.relief?.data.bbox, win = this.win.bbox;
    const box: BBox = (this.areaBox = r ? [Math.min(win[0], r[0]), Math.min(win[1], r[1]), Math.max(win[2], r[2]), Math.max(win[3], r[3])] : win);
    if (this.border) deleteVao(gl, this.border.vao);
    this.border = null;
    const { cols, rows, mask } = this.area ? rasterizeRings(this.area, box, AREA_CELL) : { cols: 1, rows: 1, mask: new Uint8Array([255]) };
    gl.bindTexture(gl.TEXTURE_2D, this.areaTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0, gl.RED, gl.UNSIGNED_BYTE, mask);
    if (!this.area) return;
    const A: number[] = [], B: number[] = [];
    for (const line of clipRings(this.area, box, BORDER_STEP)) {
      // Just above the ground, at its raw altitude (the shader exaggerates), like the network.
      const at = (k: number) => {
        const [x, , z] = this.world(line[k], line[k + 1], 0);
        return [x, this.groundAt(line[k], line[k + 1]) + 3, z];
      };
      for (let k = 2; k < line.length; k += 2) { A.push(...at(k - 2)); B.push(...at(k)); }
    }
    if (A.length) this.border = { vao: createVao(gl, this.outline, { aA: [new Float32Array(A), 3, 1], aB: [new Float32Array(B), 3, 1] }), count: A.length / 3 };
  }

  /** The terrain's height at an LV95 point: the window's, else the relief's around it, else the window's lowest. */
  private groundAt(e: number, n: number): number {
    const [w, s, east, north] = this.win.bbox, { cols, rows, cell } = this.win.grid, r = this.relief?.data;
    let h = e >= w && e <= east && n >= s && n <= north ? sampleGrid(this.win.heights, cols, rows, cell, e - w, north - n) : NaN;
    if (Number.isNaN(h) && r) h = sampleGrid(r.heights, r.cols, r.rows, r.cell, e - r.bbox[0], r.bbox[3] - n);
    return Number.isNaN(h) ? this.base : h;
  }

  /** A box's world rectangle as `uAreaRect` takes it: its north-west corner and its size. */
  private cornerRect(b: BBox): [number, number, number, number] {
    const [x, , z] = this.world(b[0], b[3], 0);
    return [x, z, b[2] - b[0], b[3] - b[1]];
  }

  /** A box's world rectangle as `uRect` takes it: its centre and its size. */
  private centreRect(b: BBox): [number, number, number, number] {
    const [x, z, w, h] = this.cornerRect(b);
    return [x + w / 2, z + h / 2, w, h];
  }

  /** How whole the terrain is at an LV95 point (`edgeMask`), 0–1: the window, or the relief around it. */
  shownAt(e: number, n: number, alt: number): number {
    const [x, , z] = this.world(e, n, alt), r = this.relief?.data;
    const fine = edgeMask(x, z, alt, this.size, [this.win.grid.minAlt, this.win.grid.maxAlt]);
    if (!r) return fine;
    const [cx, cz, w, h] = this.centreRect(r.bbox);
    return Math.max(fine, edgeMask(x - cx, z - cz, alt, [w, h], [r.minAlt, r.maxAlt]));
  }

  /** World position of an LV95 point. */
  world(e: number, n: number, alt: number): [number, number, number] {
    const [w, s] = this.win.bbox;
    return [e - w - this.size[0] / 2, (alt - this.base) * this.exaggeration, s + this.size[1] / 2 - n];
  }

  /** The inverse of `world` on the ground: the LV95 point under world (x, z). */
  ground(x: number, z: number): [number, number] {
    const [w, s] = this.win.bbox;
    return [w + x + this.size[0] / 2, s + this.size[1] / 2 - z];
  }

  /** Bilinear terrain height at an LV95 point, clamped to the window. */
  heightAt(e: number, n: number): number {
    return this.localHeight(e - this.win.bbox[0], n - this.win.bbox[1]);
  }

  /** `heightAt` in metres from the window's south-west corner, as its trails are stored. */
  private localHeight(e: number, n: number): number {
    const { grid: { cols, rows, cell }, heights } = this.win;
    // Cells beyond the national border are 0, and have no height.
    const h = sampleGrid(heights, cols, rows, cell, e, this.size[1] - n);
    return Number.isNaN(h) ? this.base : h;
  }

  private buildNetwork() {
    const { offsets, cls, xy } = this.win.trails;
    const P = new Float32Array(xy.length * 1.5);
    for (let k = 0; k < xy.length / 2; k++) {
      const e = xy[k * 2], n = xy[k * 2 + 1];
      P.set([e - this.size[0] / 2, this.localHeight(e, n) + 3, this.size[1] / 2 - n], k * 3);
    }
    let count = 0;
    for (let l = 0; l < cls.length; l++) count += Math.max(0, offsets[l + 1] - offsets[l] - 1);
    const A = new Float32Array(count * 3), B = new Float32Array(count * 3), K = new Float32Array(count);
    const first = new Uint32Array(count);
    let s = 0;
    for (let l = 0; l < cls.length; l++) {
      for (let v = offsets[l] + 1; v < offsets[l + 1]; v++, s++) {
        A.set(P.subarray((v - 1) * 3, v * 3), s * 3);
        B.set(P.subarray(v * 3, v * 3 + 3), s * 3);
        K[s] = cls[l];
        first[s] = v - 1;
      }
    }
    const gl = this.gl;
    const vao = createVao(gl, this.trails, { aA: [A, 3, 1], aB: [B, 3, 1], aClass: [K, 1, 1] });
    // aNear and aPrev change with the selected route, so they get their own buffers; until then nothing is near.
    const nearD = new Float32Array(count * 2).fill(NETWORK_REACH[1]);
    gl.bindVertexArray(vao);
    const [near, prev] = [this.trails.a.aNear, this.trails.a.aPrev].map((loc) => {
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, nearD, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
      return buffer;
    });
    gl.bindVertexArray(null);
    return { vao, count, first, near, prev, nearD };
  }

  /**
   * Fills `aNear` with each segment's walking distance from `route` and loads the trails out from
   * it; the distances it held move to `aPrev`, whose trails fade out.
   */
  private updateReach(route: RouteView | null) {
    const net = this.network, far = NETWORK_REACH[1], [w, s] = this.win.bbox;
    // The network is stored in metres from the window's corner.
    const d = route ? this.walk.distanceFrom(route.e.map((e) => e - w), route.n.map((n) => n - s), far) : null;
    const D = new Float32Array(net.count * 2).fill(far);
    if (d) for (let k = 0; k < net.count; k++) { D[k * 2] = d[net.first[k]]; D[k * 2 + 1] = d[net.first[k] + 1]; }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, net.prev);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, net.nearD);
    gl.bindBuffer(gl.ARRAY_BUFFER, net.near);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, D);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    net.nearD = D;
    this.prevFront = this.loadFront();
    this.loadT = this.still ? LOAD : 0;
    this.unloadT = this.still ? UNLOAD : 0;
  }

  /** Walking distance (m) from the selected route that its trails have loaded out to. */
  private loadFront(): number {
    return (NETWORK_REACH[1] + LOAD_EDGE) * Math.min(1, this.loadT / LOAD);
  }

  /** Contours of the current window, traced in a worker; those of the window before go at once. */
  private buildContours() {
    const { grid, heights } = this.win;
    this.contourWorker?.terminate();
    if (this.contours) deleteVao(this.gl, this.contours.vao);
    this.contours = null;
    this.contourWorker = this.traceContours(heights, grid.cols, grid.rows, (c) => { this.contours = c; this.contourWorker = null; });
  }

  /** Traces a grid's contours in a worker, which `done` receives; terminating the worker drops them. */
  private traceContours(heights: Uint16Array, cols: number, rows: number, done: (c: Contours) => void): Worker {
    const worker = new Worker(new URL('./contours.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ pos: Float32Array; weight: Float32Array }>) => {
      // Contour vertices arrive in grid units (column, altitude, row); the shader maps them to world space.
      const p = ev.data.pos;
      done({ vao: createVao(this.gl, this.lines, { aPos: [p, 3], aWeight: [ev.data.weight, 1] }), count: p.length / 3 });
      worker.terminate();
    };
    worker.postMessage({ heights, cols, rows, interval: 50, major: 250 });
    return worker;
  }

  /**
   * 0–1. In 'auto' the whole network buries the selected route, so the shader only keeps the
   * trails branching off it (`aNear`): its junctions, exits and alternatives, at any zoom.
   */
  networkOpacity(): number {
    return this.network.count === 0 || this.trailMode === 'off' ? 0 : 1;
  }

  setRoute(route: RouteView | null) {
    this.selectedRoute = route;
    this.selected = route ? this.ribbonOf(route) : null;
    // A reversed route keeps its id and footprint, so its distances stay.
    if ((route?.id ?? null) !== this.reachRoute) {
      this.reachRoute = route?.id ?? null;
      this.updateReach(route);
    }
  }
  setHover(route: RouteView | null) {
    this.hoveredRoute = route;
    this.hovered = route ? this.ribbonOf(route) : null;
  }

  private ribbonOf(r: RouteView): Ribbon {
    let ribbon = this.ribbons.get(r);
    if (!ribbon) this.ribbons.set(r, (ribbon = this.buildRibbon(r)));
    return ribbon;
  }

  private buildRibbon(r: RouteView): Ribbon {
    const n = r.e.length - 1;
    const A = new Float32Array(n * 3), B = new Float32Array(n * 3), K = new Float32Array(n);
    // Offsets from the window centre in float64, before Float32 rounds LV95's millions.
    const ce = this.win.bbox[0] + this.size[0] / 2, cn = this.win.bbox[1] + this.size[1] / 2;
    for (let i = 0; i < n; i++) {
      A.set([r.e[i] - ce, r.alt[i] + 6, cn - r.n[i]], i * 3);
      B.set([r.e[i + 1] - ce, r.alt[i + 1] + 6, cn - r.n[i + 1]], i * 3);
      K[i] = r.cls[i] === OFF_NETWORK ? 3 : r.cls[i];
    }
    const vao = createVao(this.gl, this.ribbon, { aA: [A, 3, 1], aB: [B, 3, 1], aClass: [K, 1, 1] });
    return { vao, count: n };
  }

  render(t: number, dt: number): RenderInfo {
    const gl = this.gl;
    fitCanvas(this.canvas);
    this.camera.update(dt);
    const w = this.canvas.width, h = this.canvas.height;
    const dpr = w / Math.max(1, this.canvas.clientWidth);
    gl.viewport(0, 0, w, h);
    const pal = this.palette;
    gl.clearColor(pal.clear[0], pal.clear[1], pal.clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const vp = this.camera.viewProj(w / h);
    const eye = this.camera.eye();
    const { grid } = this.win, relief = this.relief;
    const focus = Math.hypot(...eye.map((v, i) => v - this.camera.target[i]));
    const [lo, hi] = this.altRange();
    const scanAlt = lo + (hi - lo) * (0.5 - 0.5 * Math.cos(t * 0.35));
    const thin = THIN.filter((d) => this.camera.dist > d).length, stride = 2 ** thin, gain = GAIN[thin] * pal.gain;

    gl.enable(gl.BLEND);
    // Additive light on dark; premultiplied "over" on light paper, where additive light washes out.
    const over = pal.blend === 'over';
    gl.blendFunc(gl.ONE, over ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.areaTex);
    const areaRect = this.cornerRect(this.areaBox);

    /**
     * A layer: its grid and where it lies (`uCorner`), the rectangle it dissolves at with its
     * altitudes, and the finer layer it gives way to (`LAYER_GLSL`). The window is whole where it
     * lies; the relief lies around it, under its dissolving edge.
     */
    const window = { cols: grid.cols, rows: grid.rows, cell: grid.cell, corner: [-this.size[0] / 2, -this.size[1] / 2], rect: [0, 0, ...this.size], rectAlt: [grid.minAlt, grid.maxAlt] };
    const layers = [{ ...window, tex: this.heightTex, contours: this.contours, hole: [0, 0, 0, 0], holeAlt: [0, 0], step: stride, gain }];
    if (relief) {
      const r = relief.data, [cx, cz, rw, rh] = this.centreRect(r.bbox), step = Math.max(0.5, (grid.cell * stride) / r.cell);
      layers.unshift({
        cols: r.cols, rows: r.rows, cell: r.cell, corner: [cx - rw / 2, cz - rh / 2], rect: [cx, cz, rw, rh], rectAlt: [r.minAlt, r.maxAlt],
        tex: relief.tex, contours: relief.contours, hole: window.rect, holeAlt: window.rectAlt, step,
        gain: gain * Math.min(RELIEF_GAIN, ((r.cell * step) / (grid.cell * stride)) ** 2),
      });
    }

    // Point clouds.
    const P = this.points;
    gl.useProgram(P.program);
    gl.uniform1i(P.u.uH, 0);
    gl.uniform1i(P.u.uArea, 1);
    gl.uniform4fv(P.u.uAreaRect, areaRect);
    gl.uniformMatrix4fv(P.u.uVP, false, vp);
    gl.uniform3fv(P.u.uEye, eye);
    gl.uniform1f(P.u.uExag, this.exaggeration);
    gl.uniform1f(P.u.uBase, this.base);
    gl.uniform1f(P.u.uMinAlt, lo);
    gl.uniform1f(P.u.uMaxAlt, hi);
    gl.uniform1f(P.u.uFocus, focus);
    gl.uniform1f(P.u.uAperture, 0.012);
    gl.uniform1f(P.u.uViewH, this.canvas.clientHeight);
    gl.uniform1f(P.u.uDpr, dpr);
    gl.uniform1f(P.u.uScan, scanAlt);
    gl.uniform3fv(P.u.uLow, pal.low);
    gl.uniform3fv(P.u.uHigh, pal.high);
    gl.uniform3fv(P.u.uSteep, pal.steep);
    gl.uniform3fv(P.u.uScanColor, over ? [0, 0, 0] : pal.accent);
    gl.uniform1f(P.u.uPointSize, 1.6);
    gl.bindVertexArray(this.emptyVao);
    let count = 0;
    for (const l of layers) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, l.tex);
      gl.uniform2i(P.u.uGrid, l.cols, l.rows);
      gl.uniform1f(P.u.uStep, l.step);
      gl.uniform1f(P.u.uCell, l.cell);
      gl.uniform2fv(P.u.uCorner, l.corner);
      gl.uniform4fv(P.u.uRect, l.rect);
      gl.uniform2fv(P.u.uRectAlt, l.rectAlt);
      gl.uniform4fv(P.u.uHole, l.hole);
      gl.uniform2fv(P.u.uHoleAlt, l.holeAlt);
      gl.uniform1f(P.u.uGain, l.gain);
      const n = Math.ceil(l.cols / l.step) * Math.ceil(l.rows / l.step);
      gl.drawArrays(gl.POINTS, 0, n);
      count += n;
    }

    // Contours.
    const L = this.lines;
    gl.useProgram(L.program);
    gl.uniformMatrix4fv(L.u.uVP, false, vp);
    gl.uniform1f(L.u.uExag, this.exaggeration);
    gl.uniform1f(L.u.uBase, this.base);
    gl.uniform1i(L.u.uArea, 1);
    gl.uniform4fv(L.u.uAreaRect, areaRect);
    gl.uniform1f(L.u.uScan, scanAlt);
    gl.uniform1f(L.u.uAlpha, 0.16);
    gl.uniform3fv(L.u.uColor, pal.contour);
    for (const l of layers) {
      if (!l.contours) continue;
      gl.uniform1f(L.u.uCell, l.cell);
      gl.uniform2fv(L.u.uCorner, l.corner);
      gl.uniform4fv(L.u.uRect, l.rect);
      gl.uniform2fv(L.u.uRectAlt, l.rectAlt);
      gl.uniform4fv(L.u.uHole, l.hole);
      gl.uniform2fv(L.u.uHoleAlt, l.holeAlt);
      gl.bindVertexArray(l.contours.vao);
      gl.drawArrays(gl.LINES, 0, l.contours.count);
    }

    // The page's area border, in the accent as the region browser outlines the current area; under
    // the trails, so they keep their colours where they cross it.
    if (this.border) {
      const O = this.outline;
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(O.program);
      gl.uniformMatrix4fv(O.u.uVP, false, vp);
      gl.uniform2f(O.u.uViewport, w / 2, h / 2);
      gl.uniform2f(O.u.uSize, this.size[0], this.size[1]);
      gl.uniform2f(O.u.uAlt, grid.minAlt, grid.maxAlt);
      gl.uniform4fv(O.u.uRect, layers.length > 1 ? layers[0].rect : [0, 0, 0, 0]);
      gl.uniform2fv(O.u.uRectAlt, layers[0].rectAlt);
      gl.uniform1f(O.u.uExag, this.exaggeration);
      gl.uniform1f(O.u.uBase, this.base);
      gl.uniform1f(O.u.uHalf, 0.6 * dpr);
      gl.uniform1f(O.u.uAlpha, 0.85);
      gl.uniform3fv(O.u.uColor, pal.accent);
      gl.bindVertexArray(this.border.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.border.count);
    }

    // The trail network, as on a printed map: a casing in the background colour clears the
    // point cloud underneath, then the class colours go on top.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Switching to 'auto' loads the trails again, with none fading out.
    if (this.trailMode !== this.drawnMode) {
      this.drawnMode = this.trailMode;
      if (this.trailMode === 'auto' && !this.still) { this.loadT = 0; this.unloadT = UNLOAD; }
    }
    this.loadT = Math.min(LOAD, this.loadT + dt);
    this.unloadT = Math.min(UNLOAD, this.unloadT + dt);
    const show = this.networkOpacity();
    if (show > 0.01) {
      const N = this.trails;
      gl.useProgram(N.program);
      gl.uniformMatrix4fv(N.u.uVP, false, vp);
      gl.uniform2f(N.u.uViewport, w / 2, h / 2);
      gl.uniform2f(N.u.uSize, this.size[0], this.size[1]);
      gl.uniform2f(N.u.uAlt, grid.minAlt, grid.maxAlt);
      gl.uniform1i(N.u.uArea, 1);
      gl.uniform4fv(N.u.uAreaRect, areaRect);
      gl.uniform3fv(N.u.uEye, eye);
      gl.uniform1f(N.u.uExag, this.exaggeration);
      gl.uniform1f(N.u.uBase, this.base);
      gl.uniform1f(N.u.uFocus, focus);
      gl.uniform1f(N.u.uAdjacent, this.trailMode === 'auto' ? 1 : 0);
      gl.uniform2fv(N.u.uReach, NETWORK_REACH);
      gl.uniform1f(N.u.uFront, this.loadFront());
      gl.uniform1f(N.u.uPrevFront, this.prevFront);
      gl.uniform1f(N.u.uOut, 1 - this.unloadT / UNLOAD);
      gl.uniform1f(N.u.uEdge, LOAD_EDGE);
      gl.uniform1f(N.u.uHeadLen, LOAD_HEAD);
      gl.uniform3fv(N.u.uHead, pal.accent);
      gl.uniform3fv(N.u.uColors, new Float32Array(pal.trails.flat()));
      gl.uniform3fv(N.u.uCasing, pal.clear);
      gl.bindVertexArray(this.network.vao);
      for (const [pass, half, alpha] of [[0, 1.8, 0.5], [1, 0.7, this.selected ? 0.6 : 0.9]]) {
        gl.uniform1i(N.u.uPass, pass);
        gl.uniform1f(N.u.uHalf, half * dpr);
        gl.uniform1f(N.u.uAlpha, alpha * show);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.network.count);
      }
    }

    // Route ribbons.
    const R = this.ribbon;
    gl.useProgram(R.program);
    gl.uniformMatrix4fv(R.u.uVP, false, vp);
    gl.uniform2f(R.u.uViewport, w / 2, h / 2);
    gl.uniform1f(R.u.uExag, this.exaggeration);
    gl.uniform1f(R.u.uBase, this.base);
    gl.uniform3fv(R.u.uClasses, new Float32Array([...pal.trails, pal.hover].flat()));
    /**
     * Half-widths are CSS pixels up close and narrow as the camera pulls back. `color` null draws
     * the ribbon in its trail-class colours. Ribbons are opaque: where neighbouring capsules overlap
     * at a join, a translucent one would show a bead.
     */
    const zoom = zoomScale(this.camera.dist, RIBBON_SHRINK, RIBBON_FAR);
    const ribbon = (r: Ribbon, color: number[] | null, half: number) => {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniform1i(R.u.uByClass, color ? 0 : 1);
      if (color) gl.uniform3fv(R.u.uColor, color);
      gl.uniform1f(R.u.uHalf, half * zoom * dpr);
      gl.bindVertexArray(r.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, r.count);
    };
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    if (this.hovered) {
      // In the trail-class colours, like the network, with a casing so they read over the point cloud.
      ribbon(this.hovered, pal.clear, 2.2);
      ribbon(this.hovered, null, 1.1);
    }
    if (this.selected) {
      // Like the hover ribbon, a bit wider: a casing clears the network and the point cloud, and
      // the core shows the trail classes.
      ribbon(this.selected, pal.clear, 3);
      ribbon(this.selected, null, 1.8);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);

    this.fps.frames++;
    if (t - this.fps.since > 0.5) { this.fps.value = this.fps.frames / (t - this.fps.since); this.fps.frames = 0; this.fps.since = t; }
    return { vp, width: this.canvas.clientWidth, height: this.canvas.clientHeight, eye, focus, scanAlt, fps: this.fps.value, points: count, markers: zoomScale(this.camera.dist, MARKER_SHRINK, MARKER_FAR) };
  }
}
