import type { Region, RouteView } from '../data/load';
import { createProgram, createVao, fitCanvas, type Mat4, type Program } from './glkit';
import { OrbitCamera } from './camera';
import type { Resolved } from '../theme/tokens';
import { OFF_NETWORK } from '../data/types';
import { TrailNetwork } from '../geo/network';

const POINTS_VS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uH; uniform sampler2D uOrtho;
uniform ivec2 uGrid; uniform int uStride; uniform float uCell; uniform vec2 uSize;
uniform mat4 uVP; uniform vec3 uEye; uniform float uExag, uBase, uMinAlt, uMaxAlt;
uniform float uFocus, uAperture, uDpr, uScan, uMode, uGain, uPointSize, uViewH;
uniform vec3 uLow, uHigh, uSteep, uScanColor;
out vec3 vColor; out float vAlpha;

float hash(int n) { n = (n << 13) ^ n; n = n * (n * n * 15731 + 789221) + 1376312589; return float(n & 0x7fffffff) / 2147483647.0; }
float H(ivec2 c) { c = clamp(c, ivec2(0), uGrid - 1); return float(texelFetch(uH, c, 0).r) * 0.1; }

void main() {
  int cols = (uGrid.x + uStride - 1) / uStride;
  int id = gl_VertexID;
  // Jitter each point inside its cell so the regular grid never shows as moiré.
  vec2 g = vec2(float((id % cols) * uStride), float((id / cols) * uStride)) + vec2(hash(id * 2), hash(id * 2 + 1)) * float(uStride);
  ivec2 c0 = ivec2(floor(g)); vec2 f = fract(g);
  float h00 = H(c0), h10 = H(c0 + ivec2(1, 0)), h01 = H(c0 + ivec2(0, 1)), h11 = H(c0 + ivec2(1, 1));
  if (min(min(h00, h10), min(h01, h11)) <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float alt = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  float dx = (h10 - h00 + h11 - h01) * 0.5 / uCell, dz = (h01 - h00 + h11 - h10) * 0.5 / uCell;
  vec3 n = normalize(vec3(-dx * uExag, 1.0, -dz * uExag));
  vec3 world = vec3((g.x + 0.5) * uCell - uSize.x * 0.5, (alt - uBase) * uExag, (g.y + 0.5) * uCell - uSize.y * 0.5);
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
  vec3 mono = mix(uLow, uHigh, pow(t, 0.75)) * (0.3 + 0.95 * lam) + uSteep * steep * 0.5;
  vec3 photo = texture(uOrtho, (g + 0.5) / vec2(uGrid)).rgb;
  photo = mix(vec3(dot(photo, vec3(0.3, 0.59, 0.11))), photo, 1.7); // SWISSIMAGE is muted; lift saturation
  vec3 nat = max(photo, 0.0) * (0.55 + 0.8 * lam) * 1.4;
  vec3 col = mix(mono, nat, uMode);
  float scan = exp(-pow((alt - uScan) / 5.0, 2.0));
  vColor = max(col + uScanColor * scan * 1.4, 0.0);
  // Far terrain piles up at grazing angles; fade it so the foreground keeps its relief.
  float far = mix(1.0, 0.3, smoothstep(uFocus * 0.9, uFocus * 2.4, dist));
  vAlpha = (uGain * (0.5 + 0.5 * lam) + scan * 0.5) * energy * far;
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

const CONTOURS_VS = `#version 300 es
precision highp float;
in vec3 aPos; in float aWeight;
uniform mat4 uVP; uniform vec2 uSize; uniform float uCell, uExag, uBase;
out float vWeight; out float vAlt;
void main() {
  // Vertices are in grid units: (column, altitude, row).
  vec3 p = vec3((aPos.x + 0.5) * uCell - uSize.x * 0.5, aPos.y, (aPos.z + 0.5) * uCell - uSize.y * 0.5);
  gl_Position = uVP * vec4(p.x, (p.y - uBase) * uExag, p.z, 1.0);
  vWeight = aWeight; vAlt = p.y;
}`;

const CONTOURS_FS = `#version 300 es
precision mediump float;
in float vWeight; in float vAlt; out vec4 o;
uniform vec3 uColor; uniform float uAlpha, uScan;
void main() { // minor / major
  float a = uAlpha * mix(0.35, 1.0, vWeight) * (1.0 + exp(-pow((vAlt - uScan) / 12.0, 2.0)) * 2.0);
  o = vec4(uColor * a, a);
}`;

// The trail network: one instance per segment, extruded to a quad in screen space so lines keep
// their width at any DPR (GL_LINES is 1 device pixel everywhere). aNear is the walking distance
// from the selected route at A and B; with uAdjacent the network fades out over uReach (m) of it.
const NETWORK_VS = `#version 300 es
precision highp float;
in vec3 aA; in vec3 aB; in float aClass; in vec2 aNear;
uniform mat4 uVP; uniform vec2 uViewport; uniform vec3 uEye; uniform float uHalf, uExag, uBase, uFocus, uAdjacent;
uniform vec2 uReach;
out float vSide; out float vClass; out float vFade;
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
  float near = 1.0 - smoothstep(uReach.x, uReach.y, k.x < 0.5 ? aNear.x : aNear.y);
  vFade = mix(1.0, 0.35, smoothstep(uFocus * 0.9, uFocus * 2.4, distance(k.x < 0.5 ? wa : wb, uEye))) * mix(1.0, near, uAdjacent);
}`;

const NETWORK_FS = `#version 300 es
precision highp float; // uHalf is shared with the vertex shader, so precisions must match
in float vSide; in float vClass; in float vFade; out vec4 o;
uniform vec3 uColors[3]; uniform vec3 uCasing; uniform float uHalf, uAlpha; uniform int uPass;
void main() {
  float cover = clamp(uHalf + 0.5 - abs(vSide) * (uHalf + 1.0), 0.0, 1.0);
  vec3 c = uPass == 0 ? uCasing : uColors[int(vClass + 0.5)];
  float a = uAlpha * cover * vFade;
  o = vec4(c * a, a);
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
/** Seconds over which that reach grows out from a newly selected route. */
const REACH_GROW = 0.8;

/** Camera distances (m) over which route ribbons narrow to `RIBBON_FAR` of their width, so they don't swamp the overview. */
const RIBBON_SHRINK = [4000, 16000];
const RIBBON_FAR = 0.55;

export interface RenderInfo { vp: Mat4; width: number; height: number; eye: number[]; focus: number; scanAlt: number; fps: number; points: number }

/** `count` is the number of segments (instances). */
interface Ribbon { vao: WebGLVertexArrayObject; count: number }

/**
 * The 3D terrain console: a jittered point cloud of swissALTI3D heights, contour lines, the
 * full hiking network and the selected route as a screen-space ribbon. No depth test: every
 * layer is additive or blended on top, as on a hologram table.
 */
export class TerrainView {
  readonly camera = new OrbitCamera(1200, 70000);
  readonly gl: WebGL2RenderingContext;
  exaggeration = 1.5;
  mode = 0;
  trailMode: TrailMode = 'auto';
  private points: Program;
  private lines: Program;
  private trails: Program;
  private ribbon: Program;
  private heightTex: WebGLTexture;
  private orthoTex: WebGLTexture;
  private contours: { vao: WebGLVertexArrayObject; count: number } | null = null;
  /** `count` is the number of segments (instances), `first` the line vertex each one starts at, `near` the buffer of `aNear`. */
  private network: { vao: WebGLVertexArrayObject; count: number; first: Uint32Array; near: WebGLBuffer };
  private walk: TrailNetwork;
  /** The route `aNear` was computed for, and how far (0–1) its reach has grown. */
  private reachRoute: string | null = null;
  private reachGrow = 1;
  /** Under `prefers-reduced-motion` the reach doesn't grow, it is there at once. */
  private still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private selected: Ribbon | null = null;
  private hovered: Ribbon | null = null;
  private emptyVao: WebGLVertexArrayObject;
  private fps = { frames: 0, since: 0, value: 0 };
  readonly size: [number, number];
  readonly base: number;
  /** Colours and blending of the current display (src/theme); reassigned on every scheme change. */
  palette!: Resolved['gl'];

  constructor(readonly canvas: HTMLCanvasElement, readonly region: Region) {
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    const { grid, bbox } = region.bundle;
    this.size = [bbox[2] - bbox[0], bbox[3] - bbox[1]];
    this.base = grid.minAlt;
    this.points = createProgram(gl, POINTS_VS, POINTS_FS);
    this.lines = createProgram(gl, CONTOURS_VS, CONTOURS_FS);
    this.trails = createProgram(gl, NETWORK_VS, NETWORK_FS);
    this.ribbon = createProgram(gl, RIBBON_VS, RIBBON_FS);
    this.emptyVao = gl.createVertexArray()!;

    this.heightTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, grid.cols, grid.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, region.heights);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);

    this.orthoTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.orthoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, region.ortho);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

    this.walk = new TrailNetwork(region.trails);
    this.network = this.buildNetwork();
    this.buildContours();

    this.camera.target = [0, (grid.maxAlt - grid.minAlt) * 0.25 * this.exaggeration, 0];
    this.camera.az = 2.75;
    this.camera.el = 0.6;
    this.camera.dist = Math.max(...this.size) * 1.25;
    this.camera.setHome();
  }

  /** World position of a point given in metres from the bbox SW corner. */
  world(e: number, n: number, alt: number): [number, number, number] {
    return [e - this.size[0] / 2, (alt - this.base) * this.exaggeration, this.size[1] / 2 - n];
  }

  /** Bilinear terrain height at metres from the bbox SW corner. */
  heightAt(e: number, n: number): number {
    const { cols, rows, cell } = this.region.bundle.grid;
    const x = Math.min(cols - 1.001, Math.max(0, e / cell - 0.5)), y = Math.min(rows - 1.001, Math.max(0, (this.size[1] - n) / cell - 0.5));
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, h = this.region.heights;
    const at = (a: number, b: number) => h[b * cols + a] * 0.1;
    return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
  }

  private buildNetwork() {
    const { offsets, cls, xy } = this.region.trails;
    const P = new Float32Array(xy.length * 1.5);
    for (let k = 0; k < xy.length / 2; k++) {
      const e = xy[k * 2], n = xy[k * 2 + 1];
      P.set([e - this.size[0] / 2, this.heightAt(e, n) + 3, this.size[1] / 2 - n], k * 3);
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
    // aNear changes with the selected route, so it gets its own buffer; until then nothing is near.
    const near = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, near);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(count * 2).fill(NETWORK_REACH[1]), gl.DYNAMIC_DRAW);
    const loc = this.trails.a.aNear;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, 1);
    gl.bindVertexArray(null);
    return { vao, count, first, near };
  }

  /** Fills `aNear` with each segment's walking distance from `route`, and lets the reach grow out from it. */
  private updateReach(route: RouteView | null) {
    const { count, first, near } = this.network, far = NETWORK_REACH[1];
    const d = route ? this.walk.distanceFrom(route.e, route.n, far) : null;
    const D = new Float32Array(count * 2).fill(far);
    if (d) for (let s = 0; s < count; s++) { D[s * 2] = d[first[s]]; D[s * 2 + 1] = d[first[s] + 1]; }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, near);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, D);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.reachGrow = this.still ? 1 : 0;
  }

  private buildContours() {
    const { grid } = this.region.bundle;
    const worker = new Worker(new URL('./contours.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ pos: Float32Array; weight: Float32Array }>) => {
      // Contour vertices arrive in grid units (column, altitude, row); the shader maps them to world space.
      const p = ev.data.pos;
      const vao = createVao(this.gl, this.lines, { aPos: [p, 3], aWeight: [ev.data.weight, 1] });
      this.contours = { vao, count: p.length / 3 };
      worker.terminate();
    };
    worker.postMessage({ heights: this.region.heights, cols: grid.cols, rows: grid.rows, interval: 50, major: 250 });
  }

  /**
   * 0–1. In 'auto' the whole network buries the selected route, so the shader only keeps the
   * trails branching off it (`aNear`): its junctions, exits and alternatives, at any zoom.
   */
  networkOpacity(): number {
    return this.network.count === 0 || this.trailMode === 'off' ? 0 : 1;
  }

  setRoute(route: RouteView | null) {
    this.selected = route ? this.buildRibbon(route) : null;
    // A reversed route keeps its id and footprint, so its distances stay.
    if ((route?.id ?? null) !== this.reachRoute) {
      this.reachRoute = route?.id ?? null;
      this.updateReach(route);
    }
  }
  setHover(route: RouteView | null) { this.hovered = route ? this.buildRibbon(route) : null; }

  private buildRibbon(r: RouteView): Ribbon {
    const n = r.e.length - 1;
    const A = new Float32Array(n * 3), B = new Float32Array(n * 3), K = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      A.set([r.e[i] - this.size[0] / 2, r.alt[i] + 6, this.size[1] / 2 - r.n[i]], i * 3);
      B.set([r.e[i + 1] - this.size[0] / 2, r.alt[i + 1] + 6, this.size[1] / 2 - r.n[i + 1]], i * 3);
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
    const { grid } = this.region.bundle;
    const focus = Math.hypot(...eye.map((v, i) => v - this.camera.target[i]));
    const scanAlt = grid.minAlt + (grid.maxAlt - grid.minAlt) * (0.5 - 0.5 * Math.cos(t * 0.35));
    const stride = this.camera.dist > 16000 ? 2 : 1;

    gl.enable(gl.BLEND);
    // Additive light on dark; premultiplied "over" on light paper, where additive light washes out.
    const over = pal.blend === 'over';
    gl.blendFunc(gl.ONE, over ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);

    // Point cloud.
    const P = this.points;
    gl.useProgram(P.program);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.heightTex); gl.uniform1i(P.u.uH, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.orthoTex); gl.uniform1i(P.u.uOrtho, 1);
    gl.uniform2i(P.u.uGrid, grid.cols, grid.rows);
    gl.uniform1i(P.u.uStride, stride);
    gl.uniform1f(P.u.uCell, grid.cell);
    gl.uniform2f(P.u.uSize, this.size[0], this.size[1]);
    gl.uniformMatrix4fv(P.u.uVP, false, vp);
    gl.uniform3fv(P.u.uEye, eye);
    gl.uniform1f(P.u.uExag, this.exaggeration);
    gl.uniform1f(P.u.uBase, this.base);
    gl.uniform1f(P.u.uMinAlt, grid.minAlt);
    gl.uniform1f(P.u.uMaxAlt, grid.maxAlt);
    gl.uniform1f(P.u.uFocus, focus);
    gl.uniform1f(P.u.uAperture, 0.012);
    gl.uniform1f(P.u.uViewH, this.canvas.clientHeight);
    gl.uniform1f(P.u.uDpr, dpr);
    gl.uniform1f(P.u.uScan, scanAlt);
    gl.uniform1f(P.u.uMode, this.mode);
    gl.uniform1f(P.u.uGain, (stride === 2 ? 0.9 : 0.6) * (this.mode ? 0.9 : pal.gain));
    gl.uniform3fv(P.u.uLow, pal.low);
    gl.uniform3fv(P.u.uHigh, pal.high);
    gl.uniform3fv(P.u.uSteep, pal.steep);
    gl.uniform3fv(P.u.uScanColor, over ? [0, 0, 0] : pal.accent);
    gl.uniform1f(P.u.uPointSize, 1.6);
    const count = Math.ceil(grid.cols / stride) * Math.ceil(grid.rows / stride);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.POINTS, 0, count);

    // Contours.
    if (this.contours) {
      const L = this.lines;
      gl.useProgram(L.program);
      gl.uniformMatrix4fv(L.u.uVP, false, vp);
      gl.uniform2f(L.u.uSize, this.size[0], this.size[1]);
      gl.uniform1f(L.u.uCell, grid.cell);
      gl.uniform1f(L.u.uExag, this.exaggeration);
      gl.uniform1f(L.u.uBase, this.base);
      gl.uniform1f(L.u.uScan, scanAlt);
      gl.uniform1f(L.u.uAlpha, this.mode ? 0.06 : 0.16);
      gl.uniform3fv(L.u.uColor, pal.contour);
      gl.bindVertexArray(this.contours.vao);
      gl.drawArrays(gl.LINES, 0, this.contours.count);
    }

    // The trail network, as on a printed map: a casing in the background colour clears the
    // point cloud underneath, then the class colours go on top.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const show = this.networkOpacity();
    if (show > 0.01) {
      const N = this.trails;
      gl.useProgram(N.program);
      gl.uniformMatrix4fv(N.u.uVP, false, vp);
      gl.uniform2f(N.u.uViewport, w / 2, h / 2);
      gl.uniform3fv(N.u.uEye, eye);
      gl.uniform1f(N.u.uExag, this.exaggeration);
      gl.uniform1f(N.u.uBase, this.base);
      gl.uniform1f(N.u.uFocus, focus);
      this.reachGrow = Math.min(1, this.reachGrow + dt / REACH_GROW);
      const grow = 1 - (1 - this.reachGrow) ** 3;
      gl.uniform1f(N.u.uAdjacent, this.trailMode === 'auto' ? 1 : 0);
      // The +1 keeps the smoothstep edges apart while the reach is still 0.
      gl.uniform2f(N.u.uReach, NETWORK_REACH[0] * grow, NETWORK_REACH[1] * grow + 1);
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
    const [near, far] = RIBBON_SHRINK;
    const s = Math.min(1, Math.max(0, (this.camera.dist - near) / (far - near)));
    const zoom = 1 - (1 - RIBBON_FAR) * s * s * (3 - 2 * s);
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
    return { vp, width: this.canvas.clientWidth, height: this.canvas.clientHeight, eye, focus, scanAlt, fps: this.fps.value, points: count };
  }
}
