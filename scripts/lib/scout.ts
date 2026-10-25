/**
 * Scores candidate region boxes on a grid over Switzerland, from the trail network and
 * swissNAMES3D (scripts/scout-regions.ts fills the grid). Pure, so it can be unit-tested.
 */
import type { BBox } from '../../src/data/types';

/** Per-cell quantities: trail km per class, place counts, and 1 for cells inside Switzerland. */
export const LAYERS = ['wander', 'berg', 'alpin', 'hut', 'summit', 'lake', 'view', 'lift', 'rail', 'inside'] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * What a box is worth to hikers: mountain trails and huts count most, valley trails least.
 * For scale, the Jungfrau region scores about 740.
 */
export const WEIGHTS: Partial<Record<Layer, number>> = { berg: 1, alpin: 1.6, wander: 0.3, hut: 2, summit: 0.6, lake: 1.2, view: 1, lift: 0.8 };

export interface Window {
  bbox: BBox;
  score: number;
  /** Share of the box inside Switzerland; swissALTI3D has no terrain beyond the border. */
  inside: number;
  totals: Record<Layer, number>;
}

export class CellGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly data: Record<Layer, Float64Array>;
  /** Summed-area tables, (cols + 1) × (rows + 1), built on the first `sum` after a change. */
  private sums: Record<Layer, Float64Array> | null = null;

  constructor(readonly bbox: BBox, readonly cell = 1000) {
    this.cols = Math.round((bbox[2] - bbox[0]) / cell);
    this.rows = Math.round((bbox[3] - bbox[1]) / cell);
    this.data = Object.fromEntries(LAYERS.map((l) => [l, new Float64Array(this.cols * this.rows)])) as Record<Layer, Float64Array>;
  }

  /** Adds `v` to the cell containing (e, n); points outside the grid are ignored. */
  add(layer: Layer, e: number, n: number, v = 1) {
    const i = Math.floor((e - this.bbox[0]) / this.cell), j = Math.floor((n - this.bbox[1]) / this.cell);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return;
    this.data[layer][j * this.cols + i] += v;
    this.sums = null;
  }

  /** Sets every cell of `layer` from a function of the cell centre. */
  fill(layer: Layer, f: (e: number, n: number) => number) {
    for (let j = 0; j < this.rows; j++) for (let i = 0; i < this.cols; i++) {
      this.data[layer][j * this.cols + i] = f(this.bbox[0] + (i + 0.5) * this.cell, this.bbox[1] + (j + 0.5) * this.cell);
    }
    this.sums = null;
  }

  /** Sum of `layer` over the cells a box covers, its edges snapped to the grid and clamped to it. */
  sum(layer: Layer, [minE, minN, maxE, maxN]: BBox): number {
    const s = (this.sums ??= this.summedAreas())[layer], w = this.cols + 1;
    const col = (e: number) => Math.min(this.cols, Math.max(0, Math.round((e - this.bbox[0]) / this.cell)));
    const row = (n: number) => Math.min(this.rows, Math.max(0, Math.round((n - this.bbox[1]) / this.cell)));
    const [i0, i1, j0, j1] = [col(minE), col(maxE), row(minN), row(maxN)];
    return s[j1 * w + i1] - s[j0 * w + i1] - s[j1 * w + i0] + s[j0 * w + i0];
  }

  private summedAreas(): Record<Layer, Float64Array> {
    const w = this.cols + 1;
    return Object.fromEntries(LAYERS.map((l) => {
      const a = this.data[l], s = new Float64Array(w * (this.rows + 1));
      for (let j = 0; j < this.rows; j++) for (let i = 0; i < this.cols; i++) {
        s[(j + 1) * w + i + 1] = a[j * this.cols + i] + s[j * w + i + 1] + s[(j + 1) * w + i] - s[j * w + i];
      }
      return [l, s];
    })) as Record<Layer, Float64Array>;
  }
}

export function scoreWindow(grid: CellGrid, bbox: BBox): Window {
  const totals = Object.fromEntries(LAYERS.map((l) => [l, grid.sum(l, bbox)])) as Record<Layer, number>;
  const cells = ((bbox[2] - bbox[0]) / grid.cell) * ((bbox[3] - bbox[1]) / grid.cell);
  let score = 0;
  for (const [l, w] of Object.entries(WEIGHTS)) score += w * totals[l as Layer];
  return { bbox, score, inside: totals.inside / cells, totals };
}

/** Boxes that only touch along an edge don't overlap. */
export const overlaps = (a: BBox, b: BBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** The score discounted for terrain outside Switzerland, which has no data: each 1 % outside costs 2 %. */
export const borderAdjusted = (w: Window) => w.score * Math.max(0, 1 - 2 * (1 - w.inside));

/**
 * The best `size` box (metres) near `centre`, shifted by up to `reach` in grid steps, that keeps
 * every `include` point `margin` inside its edges and overlaps none of `avoid`.
 */
export function bestWindowAround(grid: CellGrid, centre: [number, number], size: [number, number], opts: { include?: [number, number][]; avoid?: BBox[]; reach?: number; margin?: number } = {}): Window | undefined {
  const { include = [], avoid = [], reach = 6000, margin = 1500 } = opts;
  const [w, h] = size, c = grid.cell;
  const e0 = Math.round((centre[0] - w / 2) / c) * c, n0 = Math.round((centre[1] - h / 2) / c) * c;
  let best: Window | undefined;
  for (let de = -reach; de <= reach; de += c) for (let dn = -reach; dn <= reach; dn += c) {
    const bbox: BBox = [e0 + de, n0 + dn, e0 + de + w, n0 + dn + h];
    if (include.some(([x, y]) => x < bbox[0] + margin || x > bbox[2] - margin || y < bbox[1] + margin || y > bbox[3] - margin)) continue;
    if (avoid.some((b) => overlaps(b, bbox))) continue;
    const win = scoreWindow(grid, bbox);
    if (!best || borderAdjusted(win) > borderAdjusted(best)) best = win;
  }
  return best;
}

/** Greedily, the `count` best boxes that overlap neither `avoid` nor each other. */
export function rankWindows(grid: CellGrid, size: [number, number], opts: { avoid?: BBox[]; count?: number; minInside?: number } = {}): Window[] {
  const { avoid = [], count = 10, minInside = 0.8 } = opts;
  const all: Window[] = [];
  for (let e = grid.bbox[0]; e + size[0] <= grid.bbox[2]; e += grid.cell) for (let n = grid.bbox[1]; n + size[1] <= grid.bbox[3]; n += grid.cell) {
    const win = scoreWindow(grid, [e, n, e + size[0], n + size[1]]);
    if (win.inside >= minInside) all.push(win);
  }
  all.sort((a, b) => borderAdjusted(b) - borderAdjusted(a));
  const chosen: Window[] = [];
  for (const win of all) {
    if (chosen.length >= count) break;
    if (![...avoid, ...chosen.map((c) => c.bbox)].some((b) => overlaps(b, win.bbox))) chosen.push(win);
  }
  return chosen;
}
