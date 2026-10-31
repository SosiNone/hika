/**
 * The partition of Switzerland into areas (see AGENTS.md, Regions), on a raster: every cell of
 * Swiss ground belongs to exactly one area. Areas grow from their seeds (swissNAMES3D outlines and
 * places) by Swiss hiking time over the terrain, so two areas meet where it is hardest to walk from
 * one into the other: on ridges, rock walls and lakes. Their borders are traced into shared arcs
 * (each border stored once) and assembled into rings. Pure, no I/O: scripts/lib/areas.ts feeds it,
 * and vitest runs it on small synthetic grids.
 */
import type { BBox } from '../../src/data/types';
import { MinHeap } from '../../src/geo/heap';
import { segmentMinutes } from '../../src/geo/hikingTime';
import { resample, simplify, type XY } from '../../src/geo/track';

/** A raster over an LV95 box. Cell (i, j) is centred at (minE + (i + ½)·cell, maxN − (j + ½)·cell): row 0 is north. */
export interface Raster { bbox: BBox; cell: number; cols: number; rows: number }

export const raster = (bbox: BBox, cell: number): Raster => ({ bbox, cell, cols: Math.round((bbox[2] - bbox[0]) / cell), rows: Math.round((bbox[3] - bbox[1]) / cell) });

/** Crossing a lake costs this many times walking the same distance on the flat shore: borders run through lakes, not along their shores. */
export const LAKE_FACTOR = 4;
/** Pieces of an area smaller than this many km² go to the neighbour they share the most border with. */
export const MIN_PIECE_KM2 = 2;

/** The cell holding an LV95 point, or −1 outside the raster. */
export function cellAt(g: Raster, e: number, n: number): number {
  const i = Math.floor((e - g.bbox[0]) / g.cell), j = Math.floor((g.bbox[3] - n) / g.cell);
  return i < 0 || j < 0 || i >= g.cols || j >= g.rows ? -1 : j * g.cols + i;
}

/** Sets `value` in every cell whose centre lies inside `rings` (even-odd, as `insideRings`); returns how many. */
export function fillRings(g: Raster, rings: XY[][], out: Int16Array | Uint8Array, value: number): number {
  const [minE, , , maxN] = g.bbox;
  let count = 0;
  const xs: number[] = [];
  for (let j = 0; j < g.rows; j++) {
    const y = maxN - (j + 0.5) * g.cell;
    xs.length = 0;
    for (const ring of rings) for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a], [xb, yb] = ring[b];
      if (ya > y !== yb > y) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - minE) / g.cell - 0.5));
      const i1 = Math.min(g.cols - 1, Math.ceil((xs[k + 1] - minE) / g.cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) { out[j * g.cols + i] = value; count++; }
    }
  }
  return count;
}

/** Sets `value` in every cell whose centre lies within `radius` of (e, n); returns how many. */
export function fillDisc(g: Raster, e: number, n: number, radius: number, out: Int16Array | Uint8Array, value: number): number {
  let count = 0;
  const r = Math.ceil(radius / g.cell) + 1, c = cellAt(g, e, n);
  if (c < 0) return 0;
  const ci = c % g.cols, cj = Math.floor(c / g.cols);
  for (let j = Math.max(0, cj - r); j <= Math.min(g.rows - 1, cj + r); j++) for (let i = Math.max(0, ci - r); i <= Math.min(g.cols - 1, ci + r); i++) {
    const x = g.bbox[0] + (i + 0.5) * g.cell, y = g.bbox[3] - (j + 0.5) * g.cell;
    if (Math.hypot(x - e, y - n) <= radius) { out[j * g.cols + i] = value; count++; }
  }
  return count;
}

/** One painted part of an area's seed: an outline or a disc, already rasterised by the caller into `cells`. */
export interface SeedPart { area: number; cells: number[] }

/**
 * The seed raster (−1 = none). Larger parts are painted first, so where outlines overlap the
 * smaller, more specific one wins (a valley inside a landscape). A seed inside another area's could
 * never grow: seeds cost nothing to cross, so the outer area takes everything around it first. So
 * an area that keeps less than half of its seed, or whose seed has almost no free ground around it,
 * is an error naming the other.
 */
export function paintSeeds(g: Raster, parts: SeedPart[], mask: Uint8Array, names: string[]): Int16Array {
  const { cols, rows } = g, seeds = new Int16Array(cols * rows).fill(-1);
  const order = parts.map((p, k) => ({ ...p, k, size: p.cells.filter((c) => mask[c]).length }))
    .sort((a, b) => b.size - a.size || a.area - b.area || a.k - b.k);
  for (const p of order) for (const c of p.cells) if (mask[c]) seeds[c] = p.area;
  const worst = (tally: Map<number, number>) => [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  for (let area = 0; area < names.length; area++) {
    const own = new Set(parts.filter((p) => p.area === area).flatMap((p) => p.cells.filter((c) => mask[c])));
    if (!own.size) throw new Error(`${names[area]}: its seeds lie outside Switzerland`);
    const taken = new Map<number, number>(), around = new Map<number, number>();
    let lost = 0, rim = 0;
    for (const c of own) {
      if (seeds[c] !== area) { taken.set(seeds[c], (taken.get(seeds[c]) ?? 0) + 1); lost++; continue; }
      const i = c % cols, j = (c - i) / cols;
      for (const nb of [i > 0 ? c - 1 : -1, i < cols - 1 ? c + 1 : -1, j > 0 ? c - cols : -1, j < rows - 1 ? c + cols : -1]) {
        if (nb < 0 || !mask[nb] || seeds[nb] === area) continue;
        rim++;
        if (seeds[nb] >= 0) around.set(seeds[nb], (around.get(seeds[nb]) ?? 0) + 1);
      }
    }
    if (lost > own.size / 2) throw new Error(`${names[area]}: ${Math.round((100 * lost) / own.size)} % of its seed lies inside the seed of ${names[worst(taken)]}, so it cannot grow; seed it with something outside`);
    const ringed = [...around.values()].reduce((s, v) => s + v, 0);
    if (rim && ringed > rim * 0.9) throw new Error(`${names[area]}: its seed lies inside the seed of ${names[worst(around)]}, so it cannot grow; seed that area with something that leaves it room`);
  }
  return seeds;
}

/**
 * Grows the seeds over the mask by Swiss hiking time (`segmentMinutes` between the centres of
 * neighbouring cells, 8 neighbours, lakes `lakeFactor` times slower): every cell goes to the area
 * whose seed is the fewest minutes' walk away. Ties go to the area reached first, which is fixed by
 * the scan order, so the result is reproducible. Cells no seed reaches stay −1.
 */
export function growAreas(g: Raster, dem: Float32Array, mask: Uint8Array, lake: Uint8Array, seeds: Int16Array, lakeFactor = LAKE_FACTOR): Int16Array {
  const { cols, rows, cell } = g, size = cols * rows;
  const label = new Int16Array(size).fill(-1);
  const dist = new Float64Array(size).fill(Infinity);
  const heap = new MinHeap();
  for (let c = 0; c < size; c++) if (mask[c] && seeds[c] >= 0) { label[c] = seeds[c]; dist[c] = 0; heap.push(c, 0); }
  const steps = [[-1, 0, cell], [1, 0, cell], [0, -1, cell], [0, 1, cell], [-1, -1, cell * Math.SQRT2], [1, -1, cell * Math.SQRT2], [-1, 1, cell * Math.SQRT2], [1, 1, cell * Math.SQRT2]];
  while (heap.size) {
    const [c, d] = heap.pop();
    if (d > dist[c]) continue;
    const i = c % cols, j = (c - i) / cols, h = dem[c];
    for (const [di, dj, len] of steps) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const nb = nj * cols + ni;
      if (!mask[nb]) continue;
      const dz = Number.isNaN(h) || Number.isNaN(dem[nb]) ? 0 : dem[nb] - h;
      const nd = d + segmentMinutes(len, dz) * (lake[c] || lake[nb] ? lakeFactor : 1);
      if (nd < dist[nb]) { dist[nb] = nd; label[nb] = label[c]; heap.push(nb, nd); }
    }
  }
  return label;
}

/**
 * Gives every masked cell still at −1 the value of the nearest cell that has one (breadth first,
 * 4 neighbours, through any cell), in place: lakes and border slivers that a range outline leaves
 * out, or ground no seed reaches.
 */
export function fillGaps(g: Raster, values: Int16Array, mask: Uint8Array) {
  const { cols, rows } = g, nearest = values.slice(), queue: number[] = [];
  for (let c = 0; c < values.length; c++) if (values[c] >= 0) queue.push(c);
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k], i = c % cols, j = (c - i) / cols;
    for (const nb of [i > 0 ? c - 1 : -1, i < cols - 1 ? c + 1 : -1, j > 0 ? c - cols : -1, j < rows - 1 ? c + cols : -1]) {
      if (nb < 0 || nearest[nb] >= 0) continue;
      nearest[nb] = nearest[c];
      if (mask[nb]) values[nb] = nearest[c];
      queue.push(nb);
    }
  }
}

/** 4-connected pieces of equal value, as lists of cells, in scan order of their first cell. */
export function pieces(g: Raster, labels: Int16Array): { value: number; cells: number[] }[] {
  const { cols, rows } = g, seen = new Uint8Array(cols * rows), out: { value: number; cells: number[] }[] = [];
  for (let start = 0; start < labels.length; start++) {
    if (seen[start] || labels[start] < 0) continue;
    const v = labels[start], cells = [start];
    seen[start] = 1;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k], i = c % cols, j = (c - i) / cols;
      for (const nb of [i > 0 ? c - 1 : -1, i < cols - 1 ? c + 1 : -1, j > 0 ? c - cols : -1, j < rows - 1 ? c + cols : -1]) {
        if (nb >= 0 && !seen[nb] && labels[nb] === v) { seen[nb] = 1; cells.push(nb); }
      }
    }
    out.push({ value: v, cells });
  }
  return out;
}

/**
 * Hands every piece of an area smaller than `minCells`, other than its largest, to the neighbour it
 * shares the most cell edges with, in place, until none is left. Larger exclaves stay: an area can
 * have several parts. Bits the border cuts off from every other area (the simplified border pinches
 * them off) belong to none: they would make outlines too small to draw. Returns the exclaves kept,
 * with their size and first cell.
 */
export function cleanIslands(g: Raster, labels: Int16Array, minCells: number): { area: number; cells: number; at: number }[] {
  const { cols, rows } = g;
  for (let round = 0; round < 20; round++) {
    const all = pieces(g, labels), largest = new Map<number, number>();
    for (const p of all) largest.set(p.value, Math.max(largest.get(p.value) ?? 0, p.cells.length));
    let moved = 0;
    for (const p of all) {
      if (p.cells.length >= minCells || p.cells.length === largest.get(p.value)) continue;
      const border = new Map<number, number>();
      for (const c of p.cells) {
        const i = c % cols, j = (c - i) / cols;
        for (const nb of [i > 0 ? c - 1 : -1, i < cols - 1 ? c + 1 : -1, j > 0 ? c - cols : -1, j < rows - 1 ? c + cols : -1]) {
          if (nb >= 0 && labels[nb] >= 0 && labels[nb] !== p.value) border.set(labels[nb], (border.get(labels[nb]) ?? 0) + 1);
        }
      }
      const to = [...border].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? -1;
      for (const c of p.cells) labels[c] = to;
      moved++;
    }
    if (!moved) {
      return all.filter((p) => p.cells.length >= minCells && p.cells.length !== largest.get(p.value)).map((p) => ({ area: p.value, cells: p.cells.length, at: p.cells[0] }));
    }
  }
  throw new Error('island clean-up did not settle');
}

/** A 0/1 mask of the cells of `label` and those up to `steps` cells from it (4 neighbours, through any cell). */
export function reach(g: Raster, labels: Int16Array, label: number, steps: number): Uint8Array {
  const { cols, rows } = g, mask = new Uint8Array(cols * rows);
  let front: number[] = [];
  for (let c = 0; c < labels.length; c++) if (labels[c] === label) { mask[c] = 1; front.push(c); }
  for (let s = 0; s < steps && front.length; s++) {
    const next: number[] = [];
    for (const c of front) {
      const i = c % cols, j = (c - i) / cols;
      for (const nb of [i > 0 ? c - 1 : -1, i < cols - 1 ? c + 1 : -1, j > 0 ? c - cols : -1, j < rows - 1 ? c + cols : -1]) {
        if (nb >= 0 && !mask[nb]) { mask[nb] = 1; next.push(nb); }
      }
    }
    front = next;
  }
  return mask;
}

/** For each of `count` labels, the value of `of` that most of its cells have (ties to the lower; −1 if none). */
export function majority(labels: Int16Array, of: Int16Array, count: number, values: number): number[] {
  const tally = Array.from({ length: count }, () => new Array<number>(values).fill(0));
  for (let c = 0; c < labels.length; c++) if (labels[c] >= 0 && of[c] >= 0) tally[labels[c]][of[c]]++;
  return tally.map((t) => (t.some((v) => v > 0) ? t.indexOf(Math.max(...t)) : -1));
}

/**
 * A point well inside each label, for its name and the map's pulse: the cell with the largest
 * chamfer distance to the label's own border (ties to the first in scan order), as LV95.
 */
export function labelPoints(g: Raster, labels: Int16Array, count: number): XY[] {
  const { cols, rows } = g, size = cols * rows, d = new Float32Array(size);
  const same = (c: number, nb: number) => nb >= 0 && labels[nb] === labels[c];
  for (let c = 0; c < size; c++) {
    if (labels[c] < 0) continue;
    const i = c % cols, j = (c - i) / cols;
    const edge = i === 0 || j === 0 || i === cols - 1 || j === rows - 1 || !same(c, c - 1) || !same(c, c + 1) || !same(c, c - cols) || !same(c, c + cols);
    d[c] = edge ? 1 : Infinity;
  }
  // Chamfer 3-4 in two passes, kept within each label.
  const pass = (forward: boolean) => {
    for (let k = 0; k < size; k++) {
      const c = forward ? k : size - 1 - k;
      if (labels[c] < 0 || d[c] === 1) continue;
      const i = c % cols, s = forward ? -1 : 1;
      const nbs: [number, number][] = [[c + s, 3], [c + s * cols, 3], [c + s * cols - 1, 4], [c + s * cols + 1, 4]];
      for (const [nb, w] of nbs) {
        const ni = nb % cols;
        if (nb < 0 || nb >= size || Math.abs(ni - i) > 1 || !same(c, nb)) continue;
        d[c] = Math.min(d[c], d[nb] + w);
      }
    }
  };
  pass(true);
  pass(false);
  const best = new Array<number>(count).fill(-1);
  for (let c = 0; c < size; c++) if (labels[c] >= 0 && (best[labels[c]] < 0 || d[c] > d[best[labels[c]]])) best[labels[c]] = c;
  return best.map((c) => (c < 0 ? [NaN, NaN] : [g.bbox[0] + ((c % cols) + 0.5) * g.cell, g.bbox[3] - (Math.floor(c / cols) + 0.5) * g.cell]));
}

/** A border between two labels (−1 = outside), as LV95 points; `left` lies to the left walking it. */
export interface Arc { left: number; right: number; pts: XY[]; closed: boolean }

/**
 * The borders between labels, each stored once: traced along cell edges, split where three or
 * more labels meet (and where two touch only at a corner), with closed loops (an enclave) kept
 * whole, then simplified to `tolerance` with their ends fixed, so neighbours still share them
 * exactly. Arcs run with the lower label on their left; their order is the scan order of the
 * raster, so the same labels always give the same arcs.
 */
export function traceArcs(g: Raster, labels: Int16Array, tolerance: number): Arc[] {
  const { cols, rows, cell } = g, vc = cols + 1;
  const L = (i: number, j: number) => (i < 0 || j < 0 || i >= cols || j >= rows ? -1 : labels[j * cols + i]);
  // Edges: horizontal (x, y)–(x+1, y) between cells (x, y−1) above and (x, y) below; vertical
  // (x, y)–(x, y+1) between cells (x−1, y) and (x, y).
  const hCount = cols * (rows + 1);
  const isEdge = (e: number) => {
    if (e < hCount) { const x = e % cols, y = (e - x) / cols; return L(x, y - 1) !== L(x, y); }
    const k = e - hCount, x = k % vc, y = (k - x) / vc;
    return L(x - 1, y) !== L(x, y);
  };
  const ends = (e: number): [number, number] => {
    if (e < hCount) { const x = e % cols, y = (e - x) / cols; return [y * vc + x, y * vc + x + 1]; }
    const k = e - hCount, x = k % vc, y = (k - x) / vc;
    return [y * vc + x, (y + 1) * vc + x];
  };
  /** The boundary edges at vertex v (x, y): west, east, north, south. */
  const at = (v: number): number[] => {
    const x = v % vc, y = (v - x) / vc, out: number[] = [];
    if (x > 0 && isEdge(y * cols + x - 1)) out.push(y * cols + x - 1);
    if (x < cols && isEdge(y * cols + x)) out.push(y * cols + x);
    if (y > 0 && isEdge(hCount + (y - 1) * vc + x)) out.push(hCount + (y - 1) * vc + x);
    if (y < rows && isEdge(hCount + y * vc + x)) out.push(hCount + y * vc + x);
    return out;
  };
  const visited = new Uint8Array(hCount + vc * rows);
  const arcs: Arc[] = [];
  const point = (v: number): XY => [g.bbox[0] + (v % vc) * cell, g.bbox[3] - Math.floor(v / vc) * cell];
  /** Left and right labels walking from vertex a to its neighbour b. */
  const sides = (a: number, b: number): [number, number] => {
    const x = a % vc, y = (a - x) / vc, bx = b % vc;
    if (b === a + 1) return [L(x, y - 1), L(x, y)];         // east: north on the left
    if (b === a - 1) return [L(bx, y), L(bx, y - 1)];       // west: south on the left
    if (b === a + vc) return [L(x, y), L(x - 1, y)];        // south: east on the left
    return [L(x - 1, y - 1), L(x, y - 1)];                  // north: west on the left
  };
  const walk = (start: number, first: number, stop: (v: number) => boolean) => {
    const vs = [start];
    let v = start, e = first;
    for (;;) {
      visited[e] = 1;
      const [a, b] = ends(e);
      v = a === v ? b : a;
      vs.push(v);
      if (stop(v)) break;
      const next = at(v).find((n) => !visited[n]);
      if (next === undefined) break;
      e = next;
    }
    return vs;
  };
  const add = (vs: number[], closed: boolean) => {
    let [left, right] = sides(vs[0], vs[1]);
    if (left > right) { vs.reverse(); [left, right] = [right, left]; }
    const pts = simplify(vs.map(point), tolerance);
    arcs.push({ left, right, pts, closed });
  };
  // Two edges at a vertex always part the same two labels; three or four end the arcs there.
  const isNode = (v: number) => at(v).length >= 3;
  for (let v = 0; v < vc * (rows + 1); v++) {
    if (!isNode(v)) continue;
    for (const e of at(v)) if (!visited[e]) add(walk(v, e, isNode), false);
  }
  for (let e = 0; e < visited.length; e++) {
    if (visited[e] || !isEdge(e)) continue;
    const [a] = ends(e);
    add(walk(a, e, (v) => v === a), true);
  }
  return arcs;
}

/**
 * The rings of one group of labels (an area, or the areas of a range), as arc references: k walks
 * arc k forwards, −(k + 1) backwards, so the group lies on the left. Only arcs with the group on one
 * side and not the other count, so a range's rings leave out the borders between its own areas.
 * Rings are chained at shared ends; the even-odd rule gives the same fill whichever way a corner
 * where the group touches itself is chained.
 */
export function assembleRings(arcs: Arc[], inGroup: (label: number) => boolean): number[][] {
  const directed: { ref: number; from: string; to: string }[] = [];
  const key = (p: XY) => `${p[0]},${p[1]}`;
  arcs.forEach((a, k) => {
    const l = inGroup(a.left), r = inGroup(a.right);
    if (l === r) return;
    const head = key(a.pts[0]), tail = key(a.pts[a.pts.length - 1]);
    directed.push(l ? { ref: k, from: head, to: tail } : { ref: -(k + 1), from: tail, to: head });
  });
  const byStart = new Map<string, number[]>();
  directed.forEach((d, k) => (byStart.get(d.from) ?? byStart.set(d.from, []).get(d.from)!).push(k));
  const used = new Uint8Array(directed.length), rings: number[][] = [];
  for (let k = 0; k < directed.length; k++) {
    if (used[k]) continue;
    const ring: number[] = [];
    let d = k;
    for (;;) {
      used[d] = 1;
      ring.push(directed[d].ref);
      if (directed[d].to === directed[k].from) break;
      const next = (byStart.get(directed[d].to) ?? []).find((n) => !used[n]);
      if (next === undefined) throw new Error(`ring of arc ${directed[k].ref} does not close`);
      d = next;
    }
    rings.push(ring);
  }
  return rings;
}

/** The points of a ring given as arc references (see `assembleRings`), closed implicitly. */
export function ringPoints(arcs: Arc[], refs: number[]): XY[] {
  const out: XY[] = [];
  for (const ref of refs) {
    const pts = ref >= 0 ? arcs[ref].pts : [...arcs[-ref - 1].pts].reverse();
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

/** Metres of a route inside each label (by its points every `step` m), and its whole length. */
export function routeShares(g: Raster, labels: Int16Array, line: XY[], step = 50): { metres: Map<number, number>; total: number } {
  const pts = resample(line, step), metres = new Map<number, number>();
  let total = 0;
  for (let k = 1; k < pts.length; k++) {
    const len = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    total += len;
    const c = cellAt(g, (pts[k][0] + pts[k - 1][0]) / 2, (pts[k][1] + pts[k - 1][1]) / 2);
    const v = c < 0 ? -1 : labels[c];
    if (v >= 0) metres.set(v, (metres.get(v) ?? 0) + len);
  }
  return { metres, total };
}

/**
 * The areas that list a route: its home area, the one holding most of it (ties to the lower index),
 * always first, then every other area holding at least its `minInside` share and `minInsideKm`,
 * by share. None if the route is not in Switzerland at all.
 */
export function listing(shares: { metres: Map<number, number>; total: number }, rules: { minInside: number; minInsideKm: number }[]): number[] {
  const byShare = [...shares.metres].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (!byShare.length || !shares.total) return [];
  const [home] = byShare[0];
  return [home, ...byShare.slice(1).filter(([a, m]) => m / shares.total >= rules[a].minInside && m / 1000 >= rules[a].minInsideKm).map(([a]) => a)];
}
