/**
 * The outlines of ranges and areas in regions.json: every border between two areas is one arc,
 * stored once in whole decametres and delta-coded ([e0, n0, de1, dn1, …]), and a ring is a list of
 * arc references (`ArcRings`). Shared by the pipeline, which encodes, and the app, which decodes.
 * Pure, no DOM.
 */
import type { ArcRings, BBox } from './types';

const UNIT = 10;

/** One arc of LV95 points (on whole decametres) as its stored form. */
export function encodeArc(pts: [number, number][]): number[] {
  const out: number[] = [];
  let pe = 0, pn = 0;
  for (const [e, n] of pts) {
    const qe = Math.round(e / UNIT), qn = Math.round(n / UNIT);
    out.push(qe - pe, qn - pn);
    pe = qe;
    pn = qn;
  }
  return out;
}

/** An arc's points as a flat [e0, n0, e1, n1, …] LV95 list. */
export function decodeArc(arc: number[]): number[] {
  const out = new Array<number>(arc.length);
  let e = 0, n = 0;
  for (let k = 0; k < arc.length; k += 2) {
    e += arc[k];
    n += arc[k + 1];
    out[k] = e * UNIT;
    out[k + 1] = n * UNIT;
  }
  return out;
}

/**
 * Rings given as arc references, as flat [e0, n0, …] LV95 rings (closed implicitly), the form the
 * locator's border and canton rings take. `arcs` are decoded arcs (`decodeArc`).
 */
export function decodeRings(arcs: number[][], rings: ArcRings): number[][] {
  return rings.map((refs) => {
    const out: number[] = [];
    for (const ref of refs) {
      const arc = ref >= 0 ? arcs[ref] : reversed(arcs[-ref - 1]);
      // Consecutive arcs share their end point.
      for (let k = out.length ? 2 : 0; k < arc.length; k++) out.push(arc[k]);
    }
    if (out.length > 2 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
    return out;
  });
}

function reversed(flat: number[]): number[] {
  const out = new Array<number>(flat.length);
  for (let k = 0; k < flat.length; k += 2) { out[flat.length - 2 - k] = flat[k]; out[flat.length - 1 - k] = flat[k + 1]; }
  return out;
}

/**
 * A flat ring with its corners cut `times` over (Chaikin): borders are traced along the cells of
 * the partition's 200 m raster, and these steps show up close. It stays within a quarter of an edge
 * of the ring, and straight stretches stay straight.
 */
export function smoothRing(ring: number[], times: number): number[] {
  let pts = ring;
  for (let t = 0; t < times; t++) {
    const out = new Array<number>(pts.length * 2);
    for (let i = 0; i < pts.length; i += 2) {
      const x0 = pts[i], y0 = pts[i + 1], x1 = pts[(i + 2) % pts.length], y1 = pts[(i + 3) % pts.length];
      out[i * 2] = 0.75 * x0 + 0.25 * x1;
      out[i * 2 + 1] = 0.75 * y0 + 0.25 * y1;
      out[i * 2 + 2] = 0.25 * x0 + 0.75 * x1;
      out[i * 2 + 3] = 0.25 * y0 + 0.75 * y1;
    }
    pts = out;
  }
  return pts;
}

/**
 * Flat rings on a grid of `cell` m over `bbox` (row 0 at the north edge, like the terrain): 255 where
 * a cell's centre lies inside them by the even-odd rule, as `insideFlat` decides, else 0. A scanline
 * fill: each row costs one pass over the edges.
 */
export function rasterizeRings(rings: number[][], [w, s, e, n]: BBox, cell: number): { cols: number; rows: number; mask: Uint8Array } {
  const cols = Math.round((e - w) / cell), rows = Math.round((n - s) / cell);
  const mask = new Uint8Array(cols * rows), xs: number[] = [];
  for (let r = 0; r < rows; r++) {
    const y = n - (r + 0.5) * cell;
    xs.length = 0;
    for (const ring of rings) for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
      if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
    xs.sort((a, b) => a - b);
    // Cells whose centre lies at or past one crossing and before the next.
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] - w) / cell - 0.5)), to = Math.min(cols, Math.ceil((xs[k + 1] - w) / cell - 0.5));
      if (from < to) mask.fill(255, r * cols + from, r * cols + to);
    }
  }
  return { cols, rows, mask };
}

/**
 * The parts of flat rings inside `bbox`, as flat [e0, n0, …] polylines with a point at least every
 * `step` m, so they can be draped on the terrain. A ring that leaves the box breaks into pieces.
 */
export function clipRings(rings: number[][], [w, s, e, n]: BBox, step: number): number[][] {
  const out: number[][] = [];
  for (const ring of rings) {
    let line: number[] = [];
    const end = () => { if (line.length >= 4) out.push(line); line = []; };
    const visit = (x: number, y: number) => { if (x >= w && x <= e && y >= s && y <= n) line.push(x, y); else end(); };
    // Each edge from its first point up to the next one, then the first point again to close it.
    for (let i = 0; i < ring.length; i += 2) {
      const x0 = ring[i], y0 = ring[i + 1], x1 = ring[(i + 2) % ring.length], y1 = ring[(i + 3) % ring.length];
      const parts = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let k = 0; k < parts; k++) visit(x0 + ((x1 - x0) * k) / parts, y0 + ((y1 - y0) * k) / parts);
    }
    if (ring.length) visit(ring[0], ring[1]);
    end();
  }
  return out;
}

/** Whether LV95 (e, n) lies inside flat rings, by the even-odd rule. */
export function insideFlat(rings: number[][], e: number, n: number): boolean {
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
