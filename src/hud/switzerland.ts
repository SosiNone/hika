import type { Locator, RegionSummary } from '../data/types';
import { lakeCells, reliefAt } from '../geo/relief';
import type { TerrainView } from '../gl/terrain';
import { FONT } from '../panels/common';
import { palette as C } from '../theme/apply';
import { hexRgb } from '../theme/tokens';

/** Screen rectangle [x0, y0, x1, y1] in CSS pixels. */
export type Rect = [number, number, number, number];

/** A region box as last drawn: its bounding rectangle and the centre of the box. */
export interface Target { region: RegionSummary; rect: Rect; cx: number; cy: number }

/** The 3D map camera's footprint in LV95, for `SwissMapOptions.cone`. */
export function cameraCone(view: TerrainView): SwissMapOptions['cone'] {
  const cam = view.camera, eye = cam.eye(), [e0, n0] = view.region.bundle.bbox;
  const [ee, en] = view.ground(eye[0], eye[2]), [te, tn] = view.ground(cam.target[0], cam.target[2]);
  const aspect = view.canvas.clientWidth / Math.max(1, view.canvas.clientHeight);
  return { eye: [e0 + ee, n0 + en], target: [e0 + te, n0 + tn], half: cam.hfov(aspect) / 2 };
}

/** The plate after a region's name on the maps: cantons and route count. */
export const regionDetail = (r: RegionSummary) => `${r.cantons.join('/')} · ${r.routes} ROUTES`;

/** Half-width, in relief cells, of the moving average that smooths draped lines. */
const RING_SMOOTH = 2;
/** Vertical exaggeration of the national relief: the country is 350 km wide, the Alps 4.6 km high. */
const EXAG = 4;
/**
 * Tilt of the view away from straight down (rad). The locator and the region browser share it, so
 * the tile grows into the same view.
 */
const TILT = 0.95;

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
  /** 'focus': only the current, hovered and selected regions are named; 'all': every region that fits. */
  labels: 'focus' | 'all';
  hover?: string | null;
  selected?: string | null;
  /** Seconds, for the current region's pulse; omitted under reduced motion. */
  pulse?: number;
  /** The 3D camera's footprint in LV95: its position on the ground, its target and half its horizontal field. */
  cone?: { eye: [number, number]; target: [number, number]; half: number } | null;
  /** Text after the name on the hovered or selected region's plate. */
  detail?: (r: RegionSummary) => string;
  /** When set, the regions a filter keeps: the others are drawn faint, unnamed and are not targets. */
  match?: Set<string> | null;
}

/**
 * The national relief as a point cloud seen at a slant, with lakes, canton and national borders,
 * and every region boxed. Borders and boxes are draped on the relief, so a box sits on the
 * mountains it covers. Shared by the locator panel (G) and the region browser.
 */
export class SwissMap {
  /** Relief points relative to the centre: x (east), z (south), altitude; and whether each is a lake cell. */
  private readonly pts: Float32Array;
  private readonly lake: Uint8Array;
  /** Draped rings as flat [x, z, alt, …] triples, like the points. */
  private readonly cantons: Float32Array[];
  private readonly border: Float32Array[];
  private readonly boxes: Map<string, { ring: Float32Array; centre: [number, number, number] }>;
  private readonly cE: number;
  private readonly cN: number;
  private fit: { u0: number; u1: number; v0: number; v1: number } | null = null;
  private relief: HTMLCanvasElement | null = null;
  private reliefKey = '';

  constructor(private readonly L: Locator, private readonly heights: Uint16Array, readonly regions: RegionSummary[], readonly current: string) {
    this.cE = (L.bbox[0] + L.bbox[2]) / 2;
    this.cN = (L.bbox[1] + L.bbox[3]) / 2;
    const lakes = lakeCells(heights, L.cols, L.rows);
    const pts: number[] = [], lake: number[] = [];
    for (let j = 0; j < L.rows; j++) for (let i = 0; i < L.cols; i++) {
      const h = heights[j * L.cols + i];
      if (!h) continue;
      pts.push(L.bbox[0] + (i + 0.5) * L.cell - this.cE, this.cN - (L.bbox[3] - (j + 0.5) * L.cell), h * 0.1);
      lake.push(lakes[j * L.cols + i]);
    }
    this.pts = Float32Array.from(pts);
    this.lake = Uint8Array.from(lake);
    this.cantons = L.cantons.map((r) => this.drape(r));
    this.border = L.border.map((r) => this.drape(r));
    this.boxes = new Map(regions.map((r) => {
      const [e0, n0, e1, n1] = r.bbox, e = (e0 + e1) / 2, n = (n0 + n1) / 2;
      return [r.id, { ring: this.drape([e0, n0, e1, n0, e1, n1, e0, n1]), centre: [e - this.cE, this.cN - n, this.alt(e, n)] }];
    }));
  }

  /** Relief altitude at LV95 (e, n), 0 abroad. */
  alt(e: number, n: number): number {
    return reliefAt(this.L, this.heights, e, n);
  }

  /**
   * A closed flat [e, n, …] LV95 ring as [x, z, alt] triples relative to the centre, with points
   * added about every relief cell so the line follows the terrain. Points abroad take the altitude
   * of the nearest point that has one, and the altitudes are smoothed over a few cells: with the
   * relief exaggerated, the raw ones make a box's edges zig-zag.
   */
  private drape(flat: number[]): Float32Array {
    const out: number[] = [];
    const count = flat.length / 2;
    for (let k = 0; k < count; k++) {
      const e0 = flat[k * 2], n0 = flat[k * 2 + 1], e1 = flat[((k + 1) % count) * 2], n1 = flat[((k + 1) % count) * 2 + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(e1 - e0, n1 - n0) / this.L.cell));
      for (let s = 0; s < steps; s++) {
        const e = e0 + ((e1 - e0) * s) / steps, n = n0 + ((n1 - n0) * s) / steps;
        out.push(e - this.cE, this.cN - n, this.alt(e, n));
      }
    }
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
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let d = -RING_SMOOTH; d <= RING_SMOOTH; d++) sum += alt[(i + d + n) % n];
      out[i * 3 + 2] = sum / (2 * RING_SMOOTH + 1);
    }
    return Float32Array.from(out);
  }

  /** Extent of the unrotated projection at unit scale, so the map keeps its size while it sways. */
  private extent() {
    if (this.fit) return this.fit;
    const ct = Math.cos(TILT), lift = EXAG * Math.sin(TILT);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < this.pts.length; k += 3) {
      const u = this.pts[k], v = this.pts[k + 1] * ct - this.pts[k + 2] * lift;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    return (this.fit = { u0, u1, v0, v1 });
  }

  /**
   * The relief in device pixels: points brighten from the background towards the scheme's terrain
   * colour with altitude. A large map samples each cell several times (bilinear), so the point
   * cloud stays dense. Lake cells are solid instead, so a lake reads as a flat patch in the dots.
   */
  private drawRelief(ctx: CanvasRenderingContext2D, dpr: number, s: number, cTilt: number, P: (x: number, z: number, alt: number) => [number, number]) {
    const img = ctx.createImageData(ctx.canvas.width, ctx.canvas.height);
    const cell = this.L.cell, cellPx = cell * s * dpr;
    const sub = Math.max(1, Math.min(4, Math.floor(cellPx / 2.5)));
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
    for (let k = 0, p = 0; k < this.pts.length; k += 3, p++) {
      const x = this.pts[k], z = this.pts[k + 1], alt = this.pts[k + 2];
      if (this.lake[p]) {
        const [sx, sy] = P(x, z, alt);
        const px = Math.round(sx * dpr), py = Math.round(sy * dpr);
        for (let dy = 0; dy < lh; dy++) for (let dx = 0; dx < lw; dx++) plot(px - (lw >> 1) + dx, py - (lh >> 1) + dy, water);
      } else if (sub === 1) point(x, z, alt);
      else {
        for (let a = 0; a < sub; a++) for (let b = 0; b < sub; b++) {
          const sx = x + ((a + 0.5) / sub - 0.5) * cell, sz = z + ((b + 0.5) / sub - 0.5) * cell;
          point(sx, sz, this.alt(this.cE + sx, this.cN - sz) || alt);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Draws the map into `ctx` (already scaled to CSS pixels) and returns every region's box as drawn. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, o: SwissMapOptions): Target[] {
    // Before layout (e.g. a page loaded hidden) the canvas is 0 × 0, and createImageData would throw.
    if (!ctx.canvas.width || !ctx.canvas.height) return [];
    const theta = o.theta ?? 0;
    const f = this.extent(), pad = 8;
    const s = Math.min((w - pad * 2) / (f.u1 - f.u0), (h - pad * 2) / (f.v1 - f.v0));
    const ox = w / 2 - ((f.u0 + f.u1) / 2) * s, oy = h / 2 - ((f.v0 + f.v1) / 2) * s;
    const ct = Math.cos(theta), st = Math.sin(theta), cTilt = Math.cos(TILT), lift = EXAG * Math.sin(TILT);
    const P = (x: number, z: number, alt: number): [number, number] => {
      const xr = x * ct - z * st, zr = x * st + z * ct;
      return [ox + xr * s, oy + (zr * cTilt - alt * lift) * s];
    };

    // The relief is kept while the view, the canvas and the scheme stay the same: a still map only
    // redraws its lines.
    const key = `${ctx.canvas.width}×${ctx.canvas.height} ${w} ${theta} ${C.gl.clear} ${C.gl.high} ${C.text}`;
    if (key !== this.reliefKey) {
      this.reliefKey = key;
      this.relief ??= document.createElement('canvas');
      this.relief.width = ctx.canvas.width;
      this.relief.height = ctx.canvas.height;
      this.drawRelief(this.relief.getContext('2d')!, ctx.canvas.width / w, s, cTilt, P);
    }
    ctx.drawImage(this.relief!, 0, 0, w, h);

    const path = (ring: Float32Array) => {
      ctx.beginPath();
      for (let k = 0; k < ring.length; k += 3) {
        const [sx, sy] = P(ring[k], ring[k + 1], ring[k + 2]);
        k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      }
      ctx.closePath();
    };
    const stroke = (color: string, width = 1) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); };
    for (const r of this.cantons) { path(r); stroke(C.ink(0.12)); }
    for (const r of this.border) { path(r); stroke(C.ink(0.55)); }

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

    // Region boxes, like the trail network on a printed map: a casing in the background colour
    // clears the relief underneath, then the outline. Neighbours share edges, so the boxes that
    // matter most are drawn last, on top.
    const rank = (r: RegionSummary) => (r.id === this.current ? 3 : r.id === o.hover || r.id === o.selected ? 2 : o.match && !o.match.has(r.id) ? 0 : 1);
    const targets: Target[] = [];
    let cur: Target | null = null;
    for (const r of [...this.regions].sort((a, b) => rank(a) - rank(b))) {
      const { ring, centre } = this.boxes.get(r.id)!;
      const k = rank(r);
      path(ring);
      stroke(C.bg, 3);
      stroke([C.ink(0.25), C.ink(0.7), C.text, C.accent][k], k === 2 ? 1.5 : 1);
      // Regions the filter leaves out are only drawn.
      if (!k) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < ring.length; k += 3) {
        const [sx, sy] = P(ring[k], ring[k + 1], ring[k + 2]);
        x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
      }
      const [cx, cy] = P(centre[0], centre[1], centre[2]);
      const t: Target = { region: r, rect: [x0, y0, x1, y1], cx, cy };
      targets.push(t);
      if (k === 3) cur = t;
    }
    if (cur && o.pulse !== undefined) {
      const pulse = (o.pulse * 0.8) % 1;
      ctx.strokeStyle = C.ac(1 - pulse);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cur.cx, cur.cy, 4 + pulse * 14, 0, Math.PI * 2); ctx.stroke();
    }
    this.label(ctx, w, h, targets, o);
    return targets;
  }

  private label(ctx: CanvasRenderingContext2D, w: number, h: number, targets: Target[], o: SwissMapOptions) {
    ctx.font = FONT(o.labels === 'all' ? 9 : 8);
    ctx.textBaseline = 'middle';
    const lh = o.labels === 'all' ? 13 : 12;
    const focused = (t: Target) => t.region.id === o.hover || t.region.id === o.selected;
    const text = (t: Target) => {
      const name = t.region.title.toUpperCase();
      return focused(t) && o.detail ? `${name} · ${o.detail(t.region)}` : name;
    };
    const rank = (t: Target) => (t.region.id === this.current ? 0 : focused(t) ? 1 : 2);
    const shown = targets.filter((t) => o.labels === 'all' || rank(t) < 2).sort((a, b) => rank(a) - rank(b));
    const items = shown.map((t) => ({ id: t.region.id, box: t.rect, w: ctx.measureText(text(t)).width + 6, h: lh, force: rank(t) < 2 }));
    const placed = placeLabels(items, w, h);
    for (const t of shown) {
      const at = placed.get(t.region.id);
      if (!at) continue;
      const isCurrent = t.region.id === this.current;
      // A plate like the map's hover readout: regions often sit on the brightest relief.
      if (o.labels === 'all' || !isCurrent) {
        ctx.fillStyle = C.bgA(focused(t) ? 0.92 : 0.7);
        ctx.fillRect(at[0], at[1], at[2] - at[0], at[3] - at[1]);
      }
      ctx.fillStyle = isCurrent ? C.accent : focused(t) ? C.text : C.text2;
      ctx.fillText(text(t), at[0] + 3, (at[1] + at[3]) / 2 + 0.5);
    }
    ctx.textBaseline = 'alphabetic';
  }
}

/**
 * The region under (x, y): of the boxes whose rectangle, grown by `pad`, holds the point, the one
 * whose centre is nearest. Neighbouring regions touch, so the first match is often the wrong one.
 */
export function hitRegion(targets: Target[], x: number, y: number, pad: number): RegionSummary | null {
  let best: Target | null = null, bd = Infinity;
  for (const t of targets) {
    const [x0, y0, x1, y1] = t.rect;
    if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) continue;
    const d = Math.hypot(x - t.cx, y - t.cy);
    if (d < bd) { bd = d; best = t; }
  }
  return best?.region ?? null;
}

export interface LabelItem { id: string; box: Rect; w: number; h: number; force?: boolean }

/**
 * Places labels beside their boxes, in the given order (most important first): right, left, above
 * or below, inside the w × h view. A label avoids the labels placed before it and, where it can, the
 * other boxes; one that fits nowhere is left out unless `force` is set, when it takes the first
 * spot that is inside the view.
 */
export function placeLabels(items: LabelItem[], w: number, h: number): Map<string, Rect> {
  const placed = new Map<string, Rect>();
  const overlaps = (a: Rect, b: Rect) => a[0] < b[2] + 1 && b[0] < a[2] + 1 && a[1] < b[3] + 1 && b[1] < a[3] + 1;
  const inside = (r: Rect) => r[0] >= 0 && r[1] >= 0 && r[2] <= w && r[3] <= h;
  for (const it of items) {
    const [x0, y0, x1, y1] = it.box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const spots: Rect[] = [[x1 + 3, cy - it.h / 2], [x0 - 3 - it.w, cy - it.h / 2], [cx - it.w / 2, y0 - 2 - it.h], [cx - it.w / 2, y1 + 2]]
      .map(([x, y]) => [x, y, x + it.w, y + it.h]);
    const free = (r: Rect, boxes: boolean) => inside(r) && ![...placed.values()].some((p) => overlaps(p, r)) &&
      (!boxes || !items.some((o) => o.id !== it.id && overlaps(o.box, r)));
    const spot = spots.find((r) => free(r, true)) ?? spots.find((r) => free(r, false)) ??
      (it.force ? clamp(spots[0], w, h) : undefined);
    if (spot) placed.set(it.id, spot);
  }
  return placed;
}

const clamp = (r: Rect, w: number, h: number): Rect => {
  const x = Math.max(0, Math.min(w - (r[2] - r[0]), r[0])), y = Math.max(0, Math.min(h - (r[3] - r[1]), r[1]));
  return [x, y, x + r[2] - r[0], y + r[3] - r[1]];
};
