import { decodeArc } from '../data/shapes';
import type { ArcRings, Locator, RangeSummary, RegionIndex, RegionSummary } from '../data/types';
import { lakeCells, reliefAt, type ReliefGrid } from '../geo/relief';
import type { TerrainView } from '../gl/terrain';
import { FONT } from '../panels/common';
import { palette as C } from '../theme/apply';
import { hexRgb } from '../theme/tokens';

/** Screen rectangle [x0, y0, x1, y1] in CSS pixels. */
export type Rect = [number, number, number, number];

/**
 * A range or an area as last drawn: its rings in screen pixels (flat [x0, y0, x1, y1, …], filled
 * even-odd), their extent and its label point.
 */
export interface Target { kind: 'range' | 'area'; id: string; rings: Float32Array[]; rect: Rect; lx: number; ly: number }

/** The 3D map camera's footprint in LV95, for `SwissMapOptions.cone`. */
export function cameraCone(view: TerrainView): SwissMapOptions['cone'] {
  const cam = view.camera, eye = cam.eye();
  const aspect = view.canvas.clientWidth / Math.max(1, view.canvas.clientHeight);
  return { eye: view.ground(eye[0], eye[2]), target: view.ground(cam.target[0], cam.target[2]), half: cam.hfov(aspect) / 2 };
}

/** The plate after an area's name on the maps: cantons and route count. */
export const regionDetail = (r: RegionSummary) => `${r.cantons.join('/')} · ${r.routes} ROUTES`;
/** The plate after a range's name: its areas and route count. */
export const rangeDetail = (g: RangeSummary) => `${g.areas.length} AREAS · ${g.routes} ROUTES`;

/** Half-width, in relief cells, of the moving average that smooths draped lines. */
const RING_SMOOTH = 2;
/** Vertical exaggeration of the national relief: the country is 350 km wide, the Alps 4.6 km high. */
const EXAG = 4;
/**
 * Tilt of the view away from straight down (rad). The locator and the region browser share it, so
 * the tile grows into the same view.
 */
const TILT = 0.95;
/** How long zooming into a range or back out takes (s). */
const ZOOM_TIME = 0.45;

/**
 * The locator's slow sway about the vertical axis, shared with the region browser. The browser draws
 * the map at the tile's angle, and the tile holds it while the browser is open, so the browser grows
 * out of the tile and shrinks back onto it without a turn. (Turning the browser's large relief would
 * redraw it every frame.)
 */
export class Sway {
  private t = 0;
  /** Set while the region browser is open. */
  held = false;

  /** The angle (rad) to draw at. */
  get theta(): number {
    return 0.32 * Math.sin(this.t * 0.12);
  }

  /** Advances by `dt` seconds, unless held. */
  step(dt: number) {
    if (!this.held) this.t += dt;
  }
}

export interface SwissMapOptions {
  /** Rotation about the vertical axis (rad), for the sway. */
  theta?: number;
  /** 'focus': only the current area and what is hovered or picked are named; 'all': everything shown that fits. */
  labels: 'focus' | 'all';
  /** The range zoomed into, whose areas are then the targets; null or omitted shows the whole country, with the ranges as targets. */
  focus?: string | null;
  /** Whether a change of `focus` zooms smoothly (off under reduced motion). */
  animate?: boolean;
  /** The range or area hovered, and the one picked by a tap. */
  hover?: string | null;
  selected?: string | null;
  /** Seconds, for the current area's pulse; omitted under reduced motion. */
  pulse?: number;
  /** The 3D camera's footprint in LV95: its position on the ground, its target and half its horizontal field. */
  cone?: { eye: [number, number]; target: [number, number]; half: number } | null;
  /** Text after the name on a hovered or picked target's plate. */
  detail?: (t: Target) => string;
  /** When set, the areas a filter keeps: the others are not targets, nor are ranges with none of them. */
  match?: Set<string> | null;
  /** An LV95 point to pin, such as the middle of a route found in the region browser. */
  mark?: [number, number] | null;
}

/** The relief as points: x (east) and z (south) from the centre and the altitude; and which are lake cells. */
interface Relief { grid: ReliefGrid; heights: Uint16Array; pts: Float32Array; lake: Uint8Array }
/** What the map shows: `s` pixels per metre, centred on the projected point (u, v). */
export interface MapView { s: number; u: number; v: number }
/** A shape draped on the relief: its rings as [x, z, alt] triples and its label point. */
interface Shape { rings: Float32Array[]; label: [number, number, number] }

/**
 * The national relief as a point cloud seen at a slant, with lakes, canton and national borders, the
 * mountain ranges and the areas that tile them. Their borders are draped on the relief, so a range
 * lies on its mountains. Shared by the locator panel (G) and the region browser, which zooms into
 * a range (`SwissMapOptions.focus`).
 */
export class SwissMap {
  private readonly cE: number;
  private readonly cN: number;
  private base: Relief;
  /** A finer relief (`setDetail`), used once loaded: the region browser zooms in. */
  private detail: Relief | null = null;
  private cantons: Float32Array[] = [];
  private border: Float32Array[] = [];
  /** Every border between areas, draped once; `inner` ones part two areas of one range. */
  private arcs: { line: Float32Array; areas: string[]; inner: boolean }[] = [];
  private areas = new Map<string, Shape & { summary: RegionSummary }>();
  private ranges = new Map<string, Shape & { summary: RangeSummary }>();
  private readonly currentRange: string | null;
  private fit: { u0: number; u1: number; v0: number; v1: number } | null = null;
  private relief: HTMLCanvasElement | null = null;
  private reliefKey = '';
  private reliefView: MapView | null = null;
  private view: MapView | null = null;
  private zoom: { from: MapView; t0: number } | null = null;
  private shownFocus: string | null | undefined = undefined;

  constructor(L: Locator, heights: Uint16Array, private readonly index: Pick<RegionIndex, 'ranges' | 'regions' | 'arcs'>, readonly current: string) {
    this.cE = (L.bbox[0] + L.bbox[2]) / 2;
    this.cN = (L.bbox[1] + L.bbox[3]) / 2;
    this.base = this.points(L, heights);
    this.currentRange = index.regions.find((r) => r.id === current)?.range ?? null;
    this.drapeAll(L);
  }

  /** Switches to a finer relief (same box), and drapes every line on it again. */
  setDetail(grid: ReliefGrid, heights: Uint16Array) {
    this.detail = this.points(grid, heights);
    this.drapeAll(grid);
    this.fit = null;
    this.reliefKey = '';
  }

  private get relief0(): Relief { return this.detail ?? this.base; }

  private points(grid: ReliefGrid, heights: Uint16Array): Relief {
    const lakes = lakeCells(heights, grid.cols, grid.rows);
    const pts: number[] = [], lake: number[] = [];
    for (let j = 0; j < grid.rows; j++) for (let i = 0; i < grid.cols; i++) {
      const h = heights[j * grid.cols + i];
      if (!h) continue;
      pts.push(grid.bbox[0] + (i + 0.5) * grid.cell - this.cE, this.cN - (grid.bbox[3] - (j + 0.5) * grid.cell), h * 0.1);
      lake.push(lakes[j * grid.cols + i]);
    }
    return { grid, heights, pts: Float32Array.from(pts), lake: Uint8Array.from(lake) };
  }

  private drapeAll(L: Pick<Locator, 'border' | 'cantons'> | ReliefGrid) {
    if ('border' in L) {
      this.cantons = L.cantons.map((r) => this.drape(r, true));
      this.border = L.border.map((r) => this.drape(r, true));
    } else {
      // Re-drape the lines already decoded, on the finer relief.
      this.cantons = this.cantons.map((r) => this.drape(this.flat(r), true));
      this.border = this.border.map((r) => this.drape(this.flat(r), true));
    }
    const { ranges, regions, arcs } = this.index;
    const flats = arcs.map(decodeArc);
    const users = flats.map(() => [] as string[]);
    for (const r of regions) for (const ref of r.rings.flat()) users[ref >= 0 ? ref : -ref - 1].push(r.id);
    const rangeOf = new Map(regions.map((r) => [r.id, r.range]));
    const lines = flats.map((flat) => this.drape(flat, false));
    this.arcs = lines.map((line, k) => ({ line, areas: users[k], inner: users[k].length === 2 && rangeOf.get(users[k][0]) === rangeOf.get(users[k][1]) }));
    const shape = (rings: ArcRings, [e, n]: [number, number]): Shape => ({ rings: rings.map((refs) => this.ring(lines, refs)), label: [e - this.cE, this.cN - n, this.alt(e, n)] });
    this.areas = new Map(regions.map((r) => [r.id, { summary: r, ...shape(r.rings, r.label) }]));
    this.ranges = new Map(ranges.map((g) => [g.id, { summary: g, ...shape(g.rings, g.label) }]));
  }

  /** Relief altitude at LV95 (e, n), 0 abroad. */
  alt(e: number, n: number): number {
    const r = this.relief0;
    return reliefAt(r.grid, r.heights, e, n);
  }

  /** Draped [x, z, alt] triples back to flat LV95 [e, n, …], to drape them again. */
  private flat(line: Float32Array): number[] {
    const out: number[] = [];
    for (let k = 0; k < line.length; k += 3) out.push(line[k] + this.cE, this.cN - line[k + 1]);
    return out;
  }

  /**
   * A flat [e, n, …] LV95 line as [x, z, alt] triples relative to the centre, with points added
   * about every relief cell so it follows the terrain. Points abroad take the altitude of the
   * nearest point that has one, and the altitudes are smoothed over a few cells: with the relief
   * exaggerated, the raw ones zig-zag. A ring (`closed`) wraps around; an arc keeps its two ends
   * at the raw relief, so the arcs that meet there still meet.
   */
  private drape(flat: number[], closed: boolean): Float32Array {
    const out: number[] = [];
    const count = flat.length / 2, cell = this.relief0.grid.cell;
    const segments = closed ? count : count - 1;
    for (let k = 0; k < segments; k++) {
      const e0 = flat[k * 2], n0 = flat[k * 2 + 1], e1 = flat[((k + 1) % count) * 2], n1 = flat[((k + 1) % count) * 2 + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(e1 - e0, n1 - n0) / cell));
      for (let s = 0; s < steps; s++) {
        const e = e0 + ((e1 - e0) * s) / steps, n = n0 + ((n1 - n0) * s) / steps;
        out.push(e - this.cE, this.cN - n, this.alt(e, n));
      }
    }
    if (!closed) out.push(flat[(count - 1) * 2] - this.cE, this.cN - flat[(count - 1) * 2 + 1], this.alt(flat[(count - 1) * 2], flat[(count - 1) * 2 + 1]));
    // Fill altitudes abroad forwards, then the leading ones backwards.
    let last = 0;
    for (let k = 2; k < out.length; k += 3) {
      if (out[k]) last = out[k];
      else out[k] = last;
    }
    for (let k = out.length - 1; k >= 2; k -= 3) {
      if (out[k]) last = out[k];
      else out[k] = last;
    }
    const n = out.length / 3, alt = Array.from({ length: n }, (_, i) => out[i * 3 + 2]);
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      let sum = 0, used = 0;
      for (let d = -RING_SMOOTH; d <= RING_SMOOTH; d++) {
        const j = closed ? (i + d + n) % n : i + d;
        if (j < 0 || j >= n) continue;
        sum += alt[j];
        used++;
      }
      out[i * 3 + 2] = sum / used;
    }
    return Float32Array.from(out);
  }

  /** A ring given as arc references, from the draped arcs. */
  private ring(lines: Float32Array[], refs: number[]): Float32Array {
    const out: number[] = [];
    for (const ref of refs) {
      const line = lines[ref >= 0 ? ref : -ref - 1], n = line.length / 3;
      for (let i = out.length ? 1 : 0; i < n; i++) {
        const p = ref >= 0 ? i : n - 1 - i;
        out.push(line[p * 3], line[p * 3 + 1], line[p * 3 + 2]);
      }
    }
    return Float32Array.from(out);
  }

  /** Extent of the unrotated projection at unit scale, so the whole country keeps its size while it sways. */
  private extent() {
    if (this.fit) return this.fit;
    const ct = Math.cos(TILT), lift = EXAG * Math.sin(TILT), pts = this.relief0.pts;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < pts.length; k += 3) {
      const u = pts[k], v = pts[k + 1] * ct - pts[k + 2] * lift;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    return (this.fit = { u0, u1, v0, v1 });
  }

  /** The view of the whole country, or of one range, in a w × h canvas at the angle `theta`. */
  private viewOf(focus: string | null, w: number, h: number, theta: number): MapView {
    const range = focus ? this.ranges.get(focus) : undefined;
    if (!range) {
      const f = this.extent(), pad = 8;
      return { s: Math.min((w - pad * 2) / (f.u1 - f.u0), (h - pad * 2) / (f.v1 - f.v0)), u: (f.u0 + f.u1) / 2, v: (f.v0 + f.v1) / 2 };
    }
    const ct = Math.cos(theta), st = Math.sin(theta), cTilt = Math.cos(TILT), lift = EXAG * Math.sin(TILT), pad = 28;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const ring of range.rings) for (let k = 0; k < ring.length; k += 3) {
      const u = ring[k] * ct - ring[k + 1] * st, v = (ring[k] * st + ring[k + 1] * ct) * cTilt - ring[k + 2] * lift;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    return { s: Math.min((w - pad * 2) / (u1 - u0), (h - pad * 2) / (v1 - v0)), u: (u0 + u1) / 2, v: (v0 + v1) / 2 };
  }

  /**
   * The relief in device pixels: points brighten from the background towards the scheme's terrain
   * colour with altitude. A large map samples each cell several times (bilinear), so the point
   * cloud stays dense. Lake cells are solid instead, so a lake reads as a flat patch in the dots.
   */
  private drawRelief(ctx: CanvasRenderingContext2D, dpr: number, s: number, cTilt: number, P: (x: number, z: number, alt: number) => [number, number]) {
    const img = ctx.createImageData(ctx.canvas.width, ctx.canvas.height);
    const { pts, lake, grid } = this.relief0;
    const cell = grid.cell, cellPx = cell * s * dpr;
    const sub = Math.max(1, Math.min(6, Math.floor(cellPx / 2.5)));
    const dot = Math.max(1, Math.round((cellPx / sub) * 0.3));
    const lw = Math.max(2, Math.ceil(cellPx)), lh = Math.max(1, Math.ceil(cellPx * cTilt));
    const bg = C.gl.clear, hi = C.gl.high, ink = hexRgb(C.text).map((c) => c / 255);
    const water = bg.map((c, k) => 255 * (c + (ink[k] - c) * 0.3));
    const plot = (px: number, py: number, rgb: ArrayLike<number>) => {
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) return;
      const k = (py * img.width + px) * 4;
      img.data[k] = rgb[0]; img.data[k + 1] = rgb[1]; img.data[k + 2] = rgb[2]; img.data[k + 3] = 255;
    };
    const rgb = [0, 0, 0];
    const point = (x: number, z: number, alt: number) => {
      const [sx, sy] = P(x, z, alt);
      const px = Math.round(sx * dpr), py = Math.round(sy * dpr);
      const t = (60 + Math.min(195, alt / 18)) / 255;
      for (let c = 0; c < 3; c++) rgb[c] = 255 * (bg[c] + (hi[c] - bg[c]) * t);
      for (let dy = 0; dy < dot; dy++) for (let dx = 0; dx < dot; dx++) plot(px + dx, py + dy, rgb);
    };
    const margin = cellPx * 2;
    for (let k = 0, p = 0; k < pts.length; k += 3, p++) {
      const x = pts[k], z = pts[k + 1], alt = pts[k + 2];
      const [sx, sy] = P(x, z, alt);
      // Zoomed in, most of the country is off the canvas.
      if (sx * dpr < -margin || sy * dpr < -margin || sx * dpr > img.width + margin || sy * dpr > img.height + margin) continue;
      if (lake[p]) {
        const px = Math.round(sx * dpr), py = Math.round(sy * dpr);
        for (let dy = 0; dy < lh; dy++) for (let dx = 0; dx < lw; dx++) plot(px - (lw >> 1) + dx, py - (lh >> 1) + dy, water);
      } else if (sub === 1) point(x, z, alt);
      else {
        for (let a = 0; a < sub; a++) for (let b = 0; b < sub; b++) {
          const ex = x + ((a + 0.5) / sub - 0.5) * cell, ez = z + ((b + 0.5) / sub - 0.5) * cell;
          point(ex, ez, this.alt(this.cE + ex, this.cN - ez) || alt);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Whether the map is still zooming (it needs another frame). */
  get zooming(): boolean { return this.zoom !== null; }

  /**
   * Draws the map into `ctx` (already scaled to CSS pixels) and returns the targets as drawn: the
   * ranges, or zoomed into one, its areas and the other ranges.
   */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, o: SwissMapOptions): Target[] {
    // Before layout (e.g. a page loaded hidden) the canvas is 0 × 0, and createImageData would throw.
    if (!ctx.canvas.width || !ctx.canvas.height) return [];
    const theta = o.theta ?? 0, focus = o.focus && this.ranges.has(o.focus) ? o.focus : null;
    const now = performance.now() / 1000;
    const goal = this.viewOf(focus, w, h, theta);
    if (focus !== this.shownFocus) {
      this.zoom = o.animate && this.view && this.shownFocus !== undefined ? { from: this.view, t0: now } : null;
      this.shownFocus = focus;
    }
    let view = goal;
    if (this.zoom) {
      const t = (now - this.zoom.t0) / ZOOM_TIME;
      if (t >= 1) this.zoom = null;
      else view = mixView(this.zoom.from, goal, ease(t));
    }
    this.view = view;
    const ct = Math.cos(theta), st = Math.sin(theta), cTilt = Math.cos(TILT), lift = EXAG * Math.sin(TILT);
    const P = (x: number, z: number, alt: number): [number, number] => {
      const xr = x * ct - z * st, zr = x * st + z * ct;
      return [w / 2 + (xr - view.u) * view.s, h / 2 + (zr * cTilt - alt * lift - view.v) * view.s];
    };

    // The relief is kept while the view, the canvas and the scheme stay the same: a still map only
    // redraws its lines. While zooming, the last one is scaled instead (redrawing it is too slow).
    const key = `${ctx.canvas.width}×${ctx.canvas.height} ${w} ${theta} ${view.s} ${view.u} ${view.v} ${C.gl.clear} ${C.gl.high} ${C.text} ${this.detail ? 'fine' : 'coarse'}`;
    if (key !== this.reliefKey && (!this.zoom || !this.reliefView)) {
      this.reliefKey = key;
      this.reliefView = view;
      this.relief ??= document.createElement('canvas');
      this.relief.width = ctx.canvas.width;
      this.relief.height = ctx.canvas.height;
      this.drawRelief(this.relief.getContext('2d')!, ctx.canvas.width / w, view.s, cTilt, P);
    }
    const drawRelief = () => {
      const r = this.reliefView!, k = view.s / r.s;
      ctx.save();
      ctx.transform(k, 0, 0, k, (w / 2) * (1 - k) + (r.u - view.u) * view.s, (h / 2) * (1 - k) + (r.v - view.v) * view.s);
      ctx.drawImage(this.relief!, 0, 0, w, h);
      ctx.restore();
    };
    drawRelief();

    const trace = (ring: Float32Array, close = true) => {
      for (let k = 0; k < ring.length; k += 3) {
        const [sx, sy] = P(ring[k], ring[k + 1], ring[k + 2]);
        k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      }
      if (close) ctx.closePath();
    };
    const path = (rings: Float32Array[]) => { ctx.beginPath(); for (const r of rings) trace(r); };
    const stroke = (color: string, width = 1) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); };
    const focused = (id: string) => id === o.hover || id === o.selected;

    // Zoomed into a range, the rest of the country recedes.
    const zoomed = focus ? this.ranges.get(focus)! : null;
    if (zoomed) {
      ctx.beginPath();
      ctx.rect(-w, -h, w * 3, h * 3);
      for (const r of zoomed.rings) trace(r);
      ctx.fillStyle = C.bgA(0.6);
      ctx.fill('evenodd');
    }
    // What the filter keeps, and the current area, are tinted; what is hovered or picked glows: its
    // relief is drawn again, brighter (darker on paper), with a faint fill and an outline.
    if (o.match) for (const id of o.match) {
      const a = this.areas.get(id);
      if (!a || (zoomed && a.summary.range !== focus)) continue;
      path(a.rings);
      ctx.fillStyle = C.ac(0.1);
      ctx.fill('evenodd');
    }
    const glow = (rings: Float32Array[], fill: number) => {
      ctx.save();
      path(rings);
      ctx.clip('evenodd');
      ctx.globalCompositeOperation = C.gl.blend === 'over' ? 'multiply' : 'lighter';
      drawRelief();
      ctx.restore();
      path(rings);
      ctx.fillStyle = C.ac(fill);
      ctx.fill('evenodd');
    };
    const cur = this.areas.get(this.current);
    if (cur) glow(cur.rings, 0.14);
    const lit = (o.hover ?? o.selected) ? (this.areas.get((o.hover ?? o.selected)!) ?? this.ranges.get((o.hover ?? o.selected)!)) : undefined;
    if (lit && lit !== cur) glow(lit.rings, 0.07);

    for (const r of this.cantons) { ctx.beginPath(); trace(r); stroke(C.ink(0.08)); }
    for (const r of this.border) { ctx.beginPath(); trace(r); stroke(C.ink(0.55)); }

    // Borders between the areas of a range are hairlines (clearer in the range zoomed into); those
    // between ranges have a casing in the background colour, like the trail network on a printed map.
    for (const arc of this.arcs) {
      if (!arc.inner) continue;
      const inFocus = zoomed && this.areas.get(arc.areas[0])?.summary.range === focus;
      if (zoomed && !inFocus) continue;
      ctx.beginPath();
      trace(arc.line, false);
      stroke(C.ink(inFocus ? 0.45 : 0.16), inFocus ? 1 : 0.75);
    }
    for (const [id, g] of this.ranges) {
      if (zoomed && id !== focus) continue;
      path(g.rings);
      stroke(C.bg, 3);
      stroke(id === focus ? C.ink(0.8) : id === this.currentRange ? C.ac(0.6) : C.ink(0.4), 1.2);
    }
    if (lit) { path(lit.rings); stroke(C.accent, 1.5); }
    if (cur) { path(cur.rings); stroke(C.accent, 1.2); }

    // The current camera footprint: a wedge from the eye on the ground towards its target.
    if (o.cone) {
      const { eye, target, half } = o.cone;
      const de = target[0] - eye[0], dn = target[1] - eye[1], len = Math.hypot(de, dn);
      if (len > 1) {
        const a = Math.atan2(dn, de), alt = this.alt(target[0], target[1]);
        const pt = (e: number, n: number) => P(e - this.cE, this.cN - n, alt);
        ctx.beginPath();
        ctx.moveTo(...pt(eye[0], eye[1]));
        for (let k = 0; k <= 8; k++) {
          const b = a - half + (2 * half * k) / 8;
          ctx.lineTo(...pt(eye[0] + Math.cos(b) * len, eye[1] + Math.sin(b) * len));
        }
        ctx.closePath();
        ctx.fillStyle = C.ac(0.15);
        ctx.fill();
        stroke(C.ac(0.7));
      }
    }

    // Targets: the areas of the range zoomed into (those the filter keeps), then every range.
    const target = (kind: Target['kind'], id: string, shape: Shape): Target => {
      const rings = shape.rings.map((ring) => {
        const out = new Float32Array((ring.length / 3) * 2);
        for (let k = 0, j = 0; k < ring.length; k += 3, j += 2) [out[j], out[j + 1]] = P(ring[k], ring[k + 1], ring[k + 2]);
        return out;
      });
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of rings) for (let k = 0; k < r.length; k += 2) { x0 = Math.min(x0, r[k]); x1 = Math.max(x1, r[k]); y0 = Math.min(y0, r[k + 1]); y1 = Math.max(y1, r[k + 1]); }
      const [lx, ly] = P(...shape.label);
      return { kind, id, rings, rect: [x0, y0, x1, y1], lx, ly };
    };
    const targets: Target[] = [];
    if (zoomed) for (const id of zoomed.summary.areas) if (!o.match || o.match.has(id)) targets.push(target('area', id, this.areas.get(id)!));
    for (const [id, g] of this.ranges) if (!o.match || g.summary.areas.some((a) => o.match!.has(a))) targets.push(target('range', id, g));

    if (cur && o.pulse !== undefined) {
      const pulse = (o.pulse * 0.8) % 1, [cx, cy] = P(...cur.label);
      ctx.strokeStyle = C.ac(1 - pulse);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, 4 + pulse * 14, 0, Math.PI * 2); ctx.stroke();
    }
    this.label(ctx, w, h, targets, cur ? target('area', this.current, cur) : null, !!zoomed, o, focused);
    if (o.mark) {
      const [e, n] = o.mark, [sx, sy] = P(e - this.cE, this.cN - n, this.alt(e, n));
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      stroke(C.bg, 4);
      stroke(C.accent, 1.5);
    }
    return targets;
  }

  private title(t: Target): string {
    return (t.kind === 'area' ? this.areas.get(t.id)!.summary.title : this.ranges.get(t.id)!.summary.title).toUpperCase();
  }

  /**
   * Names on the map, centred on the shapes: the current area in the accent, then what is hovered or
   * picked, with its plate; with `labels: 'all'`, every area of the range zoomed into, or every range.
   */
  private label(ctx: CanvasRenderingContext2D, w: number, h: number, targets: Target[], cur: Target | null, zoomed: boolean, o: SwissMapOptions, focused: (id: string) => boolean) {
    const all = o.labels === 'all';
    const shown = targets.filter((t) => (zoomed ? t.kind === 'area' : t.kind === 'range') && (all || focused(t.id)));
    const lit = targets.filter((t) => focused(t.id) && (zoomed ? true : t.kind === 'range'));
    const items: (LabelItem & { t: Target; text: string; big: boolean; tone: string })[] = [];
    const add = (t: Target, text: string, big: boolean, tone: string, force: boolean) => {
      if (items.some((i) => i.id === `${t.kind}:${t.id}`)) return;
      ctx.font = FONT(big ? 10 : 9, big ? 500 : 300);
      ctx.letterSpacing = big ? '2px' : '0px';
      items.push({ id: `${t.kind}:${t.id}`, x: t.lx, y: t.ly, w: ctx.measureText(text).width + 8, h: big ? 15 : 13, force, t, text, big, tone });
    };
    if (cur) add(cur, this.title(cur), false, C.accent, true);
    for (const t of lit) add(t, o.detail ? `${this.title(t)} · ${o.detail(t)}` : this.title(t), t.kind === 'range' && !zoomed, C.text, true);
    // Larger shapes first, so the names that drop out are the small ones'.
    for (const t of [...shown].sort((a, b) => (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]) - (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]))) {
      add(t, this.title(t), t.kind === 'range', t.kind === 'range' ? C.text2 : C.text, false);
    }
    const placed = placeAt(items, w, h);
    ctx.textBaseline = 'middle';
    for (const it of items) {
      const at = placed.get(it.id);
      if (!at) continue;
      const lifted = focused(it.t.id) || it.t === cur;
      // A plate like the map's hover readout: names often sit on the brightest relief.
      if (lifted || !it.big) {
        ctx.fillStyle = C.bgA(lifted ? 0.92 : 0.6);
        ctx.fillRect(at[0], at[1], at[2] - at[0], at[3] - at[1]);
      }
      ctx.font = FONT(it.big ? 10 : 9, it.big ? 500 : 300);
      ctx.letterSpacing = it.big ? '2px' : '0px';
      ctx.fillStyle = it.tone;
      ctx.fillText(it.text, at[0] + 4, (at[1] + at[3]) / 2 + 0.5);
    }
    ctx.letterSpacing = '0px';
    ctx.textBaseline = 'alphabetic';
  }
}

/** Ease in and out (cubic), for the zoom. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** The view `t` (0–1) of the way from `a` to `b`: the scale changes evenly in log, so a zoom feels steady. */
export function mixView(a: MapView, b: MapView, t: number): MapView {
  return { s: a.s * (b.s / a.s) ** t, u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t };
}

/** Whether (x, y) lies inside screen rings (flat [x0, y0, …]), by the even-odd rule. */
function insideScreen(rings: Float32Array[], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    if (r[i + 1] > y !== r[j + 1] > y && x < ((r[j] - r[i]) * (y - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) inside = !inside;
  }
  return inside;
}

/** Distance from (x, y) to the nearest edge of screen rings. */
function edgeDistance(rings: Float32Array[], x: number, y: number): number {
  let best = Infinity;
  for (const r of rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const ax = r[j], ay = r[j + 1], dx = r[i] - ax, dy = r[i + 1] - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return best;
}

/**
 * The target under (x, y): one whose outline holds the point, an area before a range, and of
 * several (steep relief can fold outlines over each other on screen) the one whose label is
 * nearest; else the one whose outline passes within `pad`, for a finger's slack.
 */
export function hitTarget(targets: Target[], x: number, y: number, pad: number): Target | null {
  const near = (t: Target) => Math.hypot(x - t.lx, y - t.ly);
  const holding = targets.filter((t) => x >= t.rect[0] && x <= t.rect[2] && y >= t.rect[1] && y <= t.rect[3] && insideScreen(t.rings, x, y));
  if (holding.length) return holding.sort((a, b) => (a.kind === b.kind ? near(a) - near(b) : a.kind === 'area' ? -1 : 1))[0];
  let best: Target | null = null, bd = pad;
  for (const t of targets) {
    if (x < t.rect[0] - pad || x > t.rect[2] + pad || y < t.rect[1] - pad || y > t.rect[3] + pad) continue;
    const d = edgeDistance(t.rings, x, y);
    if (d <= bd) { bd = d; best = t; }
  }
  return best;
}

export interface LabelItem { id: string; x: number; y: number; w: number; h: number; force?: boolean }

/**
 * Places labels centred on their points, in the given order (most important first), inside the
 * w × h view: one that would overlap a label placed before it moves a line up or down, and is left
 * out if neither is free, unless `force` is set, when it keeps its spot (moved into the view).
 */
export function placeAt(items: LabelItem[], w: number, h: number): Map<string, Rect> {
  const placed = new Map<string, Rect>();
  const overlaps = (a: Rect, b: Rect) => a[0] < b[2] + 1 && b[0] < a[2] + 1 && a[1] < b[3] + 1 && b[1] < a[3] + 1;
  const clamp = (r: Rect): Rect => {
    const x = Math.max(0, Math.min(w - (r[2] - r[0]), r[0])), y = Math.max(0, Math.min(h - (r[3] - r[1]), r[1]));
    return [x, y, x + r[2] - r[0], y + r[3] - r[1]];
  };
  for (const it of items) {
    const spots = [0, -1, 1].map((k): Rect => clamp([it.x - it.w / 2, it.y - it.h / 2 + k * (it.h + 1), it.x + it.w / 2, it.y + it.h / 2 + k * (it.h + 1)]));
    const spot = spots.find((r) => ![...placed.values()].some((p) => overlaps(p, r))) ?? (it.force ? spots[0] : undefined);
    if (spot) placed.set(it.id, spot);
  }
  return placed;
}
