import type { Region, RouteView } from '../data/load';
import { createProgram, createVao, fitCanvas, type Mat4, type Program } from './glkit';
import { OrbitCamera } from './camera';

const POINTS_VS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uH; uniform sampler2D uOrtho;
uniform ivec2 uGrid; uniform int uStride; uniform float uCell; uniform vec2 uSize;
uniform mat4 uVP; uniform vec3 uEye; uniform float uExag, uBase, uMinAlt, uMaxAlt;
uniform float uFocus, uAperture, uDpr, uScan, uMode, uGain, uPointSize, uViewH;
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
  vec3 mono = mix(vec3(0.05, 0.26, 0.27), vec3(0.62, 1.0, 0.86), pow(t, 0.75)) * (0.3 + 0.95 * lam) + vec3(0.2, 0.35, 0.3) * steep * 0.5;
  vec3 photo = texture(uOrtho, (g + 0.5) / vec2(uGrid)).rgb;
  photo = mix(vec3(dot(photo, vec3(0.3, 0.59, 0.11))), photo, 1.7); // SWISSIMAGE is muted; lift saturation
  vec3 nat = max(photo, 0.0) * (0.55 + 0.8 * lam) * 1.4;
  vec3 col = mix(mono, nat, uMode);
  float scan = exp(-pow((alt - uScan) / 5.0, 2.0));
  vColor = col + vec3(1.0, 0.82, 0.3) * scan * 1.4;
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

const LINES_VS = `#version 300 es
precision highp float;
in vec3 aPos; in float aWeight;
uniform mat4 uVP; uniform vec2 uSize; uniform float uCell, uExag, uBase, uLift; uniform int uGridSpace;
out float vWeight; out float vAlt;
void main() {
  vec3 p = uGridSpace == 1 ? vec3((aPos.x + 0.5) * uCell - uSize.x * 0.5, aPos.y, (aPos.z + 0.5) * uCell - uSize.y * 0.5) : aPos;
  gl_Position = uVP * vec4(p.x, (p.y - uBase) * uExag + uLift, p.z, 1.0);
  vWeight = aWeight; vAlt = p.y;
}`;

const LINES_FS = `#version 300 es
precision mediump float;
in float vWeight; in float vAlt; out vec4 o;
uniform vec3 uColors[4]; uniform float uAlpha; uniform int uMode; uniform float uScan;
void main() {
  if (uMode == 0) { // contours: minor / major
    float a = uAlpha * mix(0.35, 1.0, vWeight) * (1.0 + exp(-pow((vAlt - uScan) / 12.0, 2.0)) * 2.0);
    o = vec4(uColors[0] * a, a);
  } else {           // trail network, weight = class
    vec3 c = uColors[int(vWeight + 0.5)];
    o = vec4(c * uAlpha, uAlpha);
  }
}`;

const RIBBON_VS = `#version 300 es
precision highp float;
in vec3 aA; in vec3 aB; in vec2 aCorner; in float aDist;
uniform mat4 uVP; uniform vec2 uViewport; uniform float uWidth, uExag, uBase, uLift;
out float vDist; out float vSide;
void main() {
  vec4 a = uVP * vec4(aA.x, (aA.y - uBase) * uExag + uLift, aA.z, 1.0);
  vec4 b = uVP * vec4(aB.x, (aB.y - uBase) * uExag + uLift, aB.z, 1.0);
  vec2 sa = a.xy / a.w * uViewport, sb = b.xy / b.w * uViewport;
  vec2 dir = normalize(sb - sa + vec2(1e-5)); vec2 nrm = vec2(-dir.y, dir.x);
  vec4 p = aCorner.x < 0.5 ? a : b;
  p.xy += nrm * aCorner.y * uWidth * 2.0 / uViewport * p.w;
  gl_Position = p; vDist = aDist; vSide = aCorner.y;
}`;

const RIBBON_FS = `#version 300 es
precision mediump float;
in float vDist; in float vSide; out vec4 o;
uniform vec3 uColor; uniform float uTime, uAlpha, uFlow, uDone;
void main() {
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float dash = fract((vDist - uTime * 180.0) / 240.0);
  float pulse = uFlow * smoothstep(0.0, 0.08, dash) * smoothstep(0.45, 0.08, dash);
  float walked = step(vDist, uDone);
  vec3 c = mix(uColor, vec3(1.0), pulse * 0.6 + walked * 0.25);
  float a = uAlpha * edge * (0.75 + pulse * 0.25 + walked * 0.2);
  o = vec4(c * a, a);
}`;

export const TRAIL_RGB: [number, number, number][] = [[0.95, 0.76, 0.19], [0.93, 0.29, 0.31], [0.29, 0.57, 0.97]];
const ACCENT: [number, number, number] = [0.95, 0.76, 0.19];

export interface RenderInfo { vp: Mat4; width: number; height: number; eye: number[]; focus: number; scanAlt: number; fps: number; points: number }

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
  private points: Program;
  private lines: Program;
  private ribbon: Program;
  private heightTex: WebGLTexture;
  private orthoTex: WebGLTexture;
  private contours: { vao: WebGLVertexArrayObject; count: number } | null = null;
  private network: { vao: WebGLVertexArrayObject; count: number };
  private selected: Ribbon | null = null;
  private hovered: Ribbon | null = null;
  private emptyVao: WebGLVertexArrayObject;
  private fps = { frames: 0, since: 0, value: 0 };
  readonly size: [number, number];
  readonly base: number;
  doneMetres = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly region: Region) {
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    const { grid, bbox } = region.bundle;
    this.size = [bbox[2] - bbox[0], bbox[3] - bbox[1]];
    this.base = grid.minAlt;
    this.points = createProgram(gl, POINTS_VS, POINTS_FS);
    this.lines = createProgram(gl, LINES_VS, LINES_FS);
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
    const pos: number[] = [], weight: number[] = [];
    for (let l = 0; l < cls.length; l++) {
      for (let v = offsets[l] + 1; v < offsets[l + 1]; v++) {
        for (const k of [v - 1, v]) {
          const e = xy[k * 2], n = xy[k * 2 + 1];
          pos.push(e - this.size[0] / 2, this.heightAt(e, n) + 3, this.size[1] / 2 - n);
          weight.push(cls[l]);
        }
      }
    }
    const vao = createVao(this.gl, this.lines, { aPos: [new Float32Array(pos), 3], aWeight: [new Float32Array(weight), 1] });
    return { vao, count: pos.length / 3 };
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

  setRoute(route: RouteView | null) { this.selected = route ? this.buildRibbon(route) : null; }
  setHover(route: RouteView | null) { this.hovered = route ? this.buildRibbon(route) : null; }

  private buildRibbon(r: RouteView): Ribbon {
    const n = r.e.length - 1;
    const A = new Float32Array(n * 18), B = new Float32Array(n * 18), C = new Float32Array(n * 12), D = new Float32Array(n * 6);
    const corners = [[0, -1], [1, -1], [0, 1], [0, 1], [1, -1], [1, 1]];
    for (let i = 0; i < n; i++) {
      const a = [r.e[i] - this.size[0] / 2, r.alt[i] + 6, this.size[1] / 2 - r.n[i]];
      const b = [r.e[i + 1] - this.size[0] / 2, r.alt[i + 1] + 6, this.size[1] / 2 - r.n[i + 1]];
      corners.forEach(([end, side], k) => {
        const v = i * 6 + k;
        A.set(a, v * 3); B.set(b, v * 3); C.set([end, side], v * 2); D[v] = (i + end) * r.step;
      });
    }
    const vao = createVao(this.gl, this.ribbon, { aA: [A, 3], aB: [B, 3], aCorner: [C, 2], aDist: [D, 1] });
    return { vao, count: n * 6 };
  }

  render(t: number, dt: number): RenderInfo {
    const gl = this.gl;
    fitCanvas(this.canvas);
    this.camera.update(dt);
    const w = this.canvas.width, h = this.canvas.height;
    const dpr = w / Math.max(1, this.canvas.clientWidth);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.024, 0.031, 0.035, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const vp = this.camera.viewProj(w / h);
    const eye = this.camera.eye();
    const { grid } = this.region.bundle;
    const focus = Math.hypot(...eye.map((v, i) => v - this.camera.target[i]));
    const scanAlt = grid.minAlt + (grid.maxAlt - grid.minAlt) * (0.5 - 0.5 * Math.cos(t * 0.35));
    const stride = this.camera.dist > 16000 ? 2 : 1;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

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
    gl.uniform1f(P.u.uGain, (stride === 2 ? 0.9 : 0.6) * (this.mode ? 0.9 : 1));
    gl.uniform1f(P.u.uPointSize, 1.6);
    const count = Math.ceil(grid.cols / stride) * Math.ceil(grid.rows / stride);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.POINTS, 0, count);

    // Contours and the trail network.
    const L = this.lines;
    gl.useProgram(L.program);
    gl.uniformMatrix4fv(L.u.uVP, false, vp);
    gl.uniform2f(L.u.uSize, this.size[0], this.size[1]);
    gl.uniform1f(L.u.uCell, grid.cell);
    gl.uniform1f(L.u.uExag, this.exaggeration);
    gl.uniform1f(L.u.uBase, this.base);
    gl.uniform1f(L.u.uScan, scanAlt);
    if (this.contours) {
      gl.uniform1i(L.u.uGridSpace, 1);
      gl.uniform1i(L.u.uMode, 0);
      gl.uniform1f(L.u.uLift, 0);
      gl.uniform1f(L.u.uAlpha, this.mode ? 0.06 : 0.16);
      gl.uniform3fv(L.u.uColors, new Float32Array([0.55, 0.95, 0.82, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
      gl.bindVertexArray(this.contours.vao);
      gl.drawArrays(gl.LINES, 0, this.contours.count);
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(L.u.uGridSpace, 0);
    gl.uniform1i(L.u.uMode, 1);
    gl.uniform1f(L.u.uLift, 0);
    gl.uniform1f(L.u.uAlpha, this.selected ? 0.16 : 0.3);
    gl.uniform3fv(L.u.uColors, new Float32Array([...TRAIL_RGB.flat(), 1, 1, 1]));
    gl.bindVertexArray(this.network.vao);
    gl.drawArrays(gl.LINES, 0, this.network.count);

    // Route ribbons.
    const R = this.ribbon;
    gl.useProgram(R.program);
    gl.uniformMatrix4fv(R.u.uVP, false, vp);
    gl.uniform2f(R.u.uViewport, w / 2, h / 2);
    gl.uniform1f(R.u.uExag, this.exaggeration);
    gl.uniform1f(R.u.uBase, this.base);
    gl.uniform1f(R.u.uLift, 0);
    gl.uniform1f(R.u.uTime, t);
    if (this.hovered) {
      gl.uniform3f(R.u.uColor, 1, 1, 1);
      gl.uniform1f(R.u.uWidth, 1.4 * dpr);
      gl.uniform1f(R.u.uAlpha, 0.7);
      gl.uniform1f(R.u.uFlow, 0);
      gl.uniform1f(R.u.uDone, -1);
      gl.bindVertexArray(this.hovered.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.hovered.count);
    }
    if (this.selected) {
      gl.uniform3fv(R.u.uColor, ACCENT);
      gl.uniform1f(R.u.uWidth, 2.2 * dpr);
      gl.uniform1f(R.u.uAlpha, 1);
      gl.uniform1f(R.u.uFlow, 1);
      gl.uniform1f(R.u.uDone, this.doneMetres);
      gl.bindVertexArray(this.selected.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.selected.count);
    }
    gl.bindVertexArray(null);

    this.fps.frames++;
    if (t - this.fps.since > 0.5) { this.fps.value = this.fps.frames / (t - this.fps.since); this.fps.frames = 0; this.fps.since = t; }
    return { vp, width: this.canvas.clientWidth, height: this.canvas.clientHeight, eye, focus, scanAlt, fps: this.fps.value, points: count };
  }
}
