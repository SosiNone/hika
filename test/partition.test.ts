import { describe, expect, it } from 'vitest';
import { insideRings, type XY } from '../src/geo/track';
import {
  assembleRings, cellAt, cleanIslands, fillDisc, fillGaps, fillRings, growAreas, labelPoints, listing, majority, paintSeeds, reach,
  raster, ringPoints, routeShares, traceArcs,
} from '../scripts/lib/partition';

const square = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
/** A raster of `cols` × `rows` cells of 100 m with its south-west corner at the origin. */
const grid = (cols: number, rows: number) => raster([0, 0, cols * 100, rows * 100], 100);
const labelsOf = (rows: number[][]) => Int16Array.from(rows.flat());
const shoelace = (pts: XY[]) => Math.abs(pts.reduce((s, [x, y], k) => { const [x2, y2] = pts[(k + 1) % pts.length]; return s + x * y2 - x2 * y; }, 0)) / 2;

describe('fillRings', () => {
  it('fills the cells whose centres lie inside, leaving holes out', () => {
    const g = raster([0, 0, 100, 100], 10), out = new Int16Array(100).fill(-1);
    expect(fillRings(g, [square(10, 10, 90, 90), square(40, 40, 60, 60)], out, 3)).toBe(60);
    expect(out[cellAt(g, 15, 15)]).toBe(3);
    expect(out[cellAt(g, 45, 55)]).toBe(-1);
    expect(out[cellAt(g, 5, 50)]).toBe(-1);
  });
});

describe('fillDisc', () => {
  it('fills the cells within the radius', () => {
    const g = grid(10, 10), out = new Int16Array(100).fill(-1);
    expect(fillDisc(g, 500, 500, 100, out, 1)).toBe(4);
  });
});

describe('growAreas', () => {
  const g = grid(20, 5), mask = new Uint8Array(100).fill(1), none = new Uint8Array(100);
  const seedCols = (a: number[], b: number[]) => {
    const s = new Int16Array(100).fill(-1);
    for (let j = 0; j < 5; j++) { for (const i of a) s[j * 20 + i] = 0; for (const i of b) s[j * 20 + i] = 1; }
    return s;
  };
  const row = (labels: Int16Array) => Array.from(labels.slice(40, 60));

  it('puts the border on the crest between two valleys, not halfway', () => {
    // Valley floors at columns 0–2 and 17–19, a crest at column 12: a gentle climb from the west, a steep one from the east.
    const alt = (i: number) => (i <= 2 ? 1000 : i <= 12 ? 1000 + 20 * (i - 2) : i < 17 ? 1200 - 40 * (i - 12) : 1000);
    const dem = Float32Array.from({ length: 100 }, (_, c) => alt(c % 20));
    const first = row(growAreas(g, dem, mask, none, seedCols([0, 1, 2], [17, 18, 19]))).indexOf(1);
    expect(first).toBeGreaterThanOrEqual(11);
    expect(first).toBeLessThanOrEqual(13);
  });

  it('pulls the border into a lake, which is slow to cross', () => {
    const dem = new Float32Array(100).fill(500), lake = new Uint8Array(100);
    for (let j = 0; j < 5; j++) for (let i = 12; i <= 15; i++) lake[j * 20 + i] = 1;
    const seeds = seedCols([0], [19]);
    expect(row(growAreas(g, dem, mask, none, seeds)).indexOf(1)).toBe(10);
    const first = row(growAreas(g, dem, mask, lake, seeds)).indexOf(1);
    expect(first).toBeGreaterThan(12);
    expect(first).toBeLessThanOrEqual(15);
  });

  it('leaves cells outside the mask and out of reach unlabelled, and is reproducible', () => {
    const dem = new Float32Array(100).fill(500), m = mask.slice();
    for (let j = 0; j < 5; j++) m[j * 20 + 10] = 0;
    const seeds = seedCols([0], []);
    const a = growAreas(g, dem, m, none, seeds);
    expect(row(a).slice(0, 10).every((v) => v === 0)).toBe(true);
    expect(row(a).slice(10).every((v) => v === -1)).toBe(true);
    expect(growAreas(g, dem, m, none, seeds)).toEqual(a);
  });
});

describe('paintSeeds', () => {
  const g = grid(10, 10), mask = new Uint8Array(100).fill(1);
  const cellsOf = (rings: XY[][]) => { const out = new Int16Array(100).fill(-1); fillRings(g, rings, out, 1); return [...out.keys()].filter((c) => out[c] === 1); };

  it('lets the smaller outline win where two overlap', () => {
    const seeds = paintSeeds(g, [{ area: 0, cells: cellsOf([square(0, 0, 600, 1000)]) }, { area: 1, cells: cellsOf([square(400, 0, 1000, 600)]) }], mask, ['a', 'b']);
    expect(seeds[cellAt(g, 450, 450)]).toBe(1);
    expect(seeds[cellAt(g, 450, 850)]).toBe(0);
  });

  it('rejects a seed that lies mostly inside another', () => {
    const parts = [{ area: 0, cells: cellsOf([square(0, 0, 1000, 400)]) }, { area: 1, cells: cellsOf([square(100, 0, 900, 300)]) }];
    expect(() => paintSeeds(g, parts, mask, ['outer', 'inner'])).toThrow(/outer: 60 % of its seed lies inside the seed of inner/);
  });

  it('rejects a seed ringed by another, which could never grow', () => {
    const disc = new Int16Array(100).fill(-1);
    fillDisc(g, 500, 500, 100, disc, 1);
    const parts = [{ area: 0, cells: cellsOf([square(0, 0, 800, 800)]) }, { area: 1, cells: [...disc.keys()].filter((c) => disc[c] === 1) }];
    expect(() => paintSeeds(g, parts, mask, ['rheintal', 'chur'])).toThrow(/chur: its seed lies inside the seed of rheintal/);
  });
});

describe('fillGaps', () => {
  it('fills masked cells from the nearest value, through unmasked ones', () => {
    const g = grid(5, 1), v = Int16Array.of(2, -1, -1, -1, 7), mask = Uint8Array.of(1, 0, 1, 1, 1);
    fillGaps(g, v, mask);
    expect(Array.from(v)).toEqual([2, -1, 2, 7, 7]);
  });
});

describe('cleanIslands', () => {
  it('hands small pieces to their neighbour and keeps large exclaves', () => {
    const g = grid(8, 4);
    const labels = labelsOf([
      [0, 0, 0, 0, 0, 1, 1, 1],
      [0, 1, 0, 0, 0, 1, 1, 1],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 1, 1, 1, 0],
    ]);
    const kept = cleanIslands(g, labels, 3);
    expect(labels[9]).toBe(0);
    expect(kept).toEqual([{ area: 1, cells: 4, at: 27 }]);
  });

  it('drops a small bit of ground cut off from every other area', () => {
    const g = grid(5, 1), labels = Int16Array.of(0, 0, 0, -1, 0);
    expect(cleanIslands(g, labels, 3)).toEqual([]);
    expect(Array.from(labels)).toEqual([0, 0, 0, -1, -1]);
  });
});

describe('reach', () => {
  it('marks a label and the cells a few steps around it', () => {
    const mask = reach(grid(6, 1), Int16Array.of(0, 0, 1, 1, 1, 1), 0, 2);
    expect(Array.from(mask)).toEqual([1, 1, 1, 1, 0, 0]);
  });
});

describe('majority', () => {
  it('picks the most common value per label', () => {
    expect(majority(Int16Array.of(0, 0, 0, 1, 1), Int16Array.of(2, 1, 1, 0, -1), 2, 3)).toEqual([1, 0]);
  });
});

describe('labelPoints', () => {
  it('finds the point deepest inside each label', () => {
    const g = grid(7, 5);
    const labels = labelsOf([[0, 0, 0, 0, 0, 1, 1], [0, 0, 0, 0, 0, 1, 1], [0, 0, 0, 0, 0, 1, 1], [0, 0, 0, 0, 0, 1, 1], [0, 0, 0, 0, 0, 1, 1]]);
    const [p] = labelPoints(g, labels, 2);
    expect(p).toEqual([250, 250]);
  });
});

describe('traceArcs and assembleRings', () => {
  it('stores a shared border once and closes both rings with it', () => {
    const g = grid(4, 2);
    const labels = labelsOf([[0, 0, 1, 1], [0, 0, 1, 1]]);
    const arcs = traceArcs(g, labels, 1);
    const shared = arcs.filter((a) => a.left === 0 && a.right === 1);
    expect(shared).toHaveLength(1);
    expect(shared[0].pts.map(([x]) => x)).toEqual([200, 200]);
    for (const label of [0, 1]) {
      const rings = assembleRings(arcs, (l) => l === label);
      expect(rings).toHaveLength(1);
      expect(shoelace(ringPoints(arcs, rings[0]))).toBe(40_000);
    }
  });

  it('gives an enclave closed arcs and its host a hole', () => {
    const g = grid(5, 5);
    const labels = new Int16Array(25);
    labels[12] = 1;
    const arcs = traceArcs(g, labels, 1);
    expect(arcs.every((a) => a.closed)).toBe(true);
    const rings = assembleRings(arcs, (l) => l === 0).map((r) => ringPoints(arcs, r));
    expect(rings).toHaveLength(2);
    expect(insideRings(rings, 250, 250)).toBe(false);
    expect(insideRings(rings, 150, 250)).toBe(true);
  });

  it('splits arcs where labels touch only at a corner', () => {
    const g = grid(2, 2);
    const arcs = traceArcs(g, labelsOf([[0, 1], [1, 0]]), 1);
    const rings = assembleRings(arcs, (l) => l === 0).map((r) => ringPoints(arcs, r));
    expect(rings.reduce((s, r) => s + shoelace(r), 0)).toBe(20_000);
    expect(insideRings(rings, 50, 150)).toBe(true);
    expect(insideRings(rings, 150, 150)).toBe(false);
  });

  it('simplifies arcs but keeps their ends where three labels meet', () => {
    const g = grid(6, 3);
    const labels = labelsOf([[0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1], [2, 2, 2, 2, 2, 2]]);
    const arcs = traceArcs(g, labels, 150);
    const shared = arcs.find((a) => a.left === 0 && a.right === 1)!;
    // Northwards, with 0 (west) on the left.
    expect(shared.pts).toEqual([[300, 100], [300, 300]]);
    const outer = arcs.find((a) => a.left === -1 && a.right === 2)!;
    expect(outer.pts.length).toBeLessThan(10);
    for (const label of [0, 1, 2]) expect(() => assembleRings(arcs, (l) => l === label)).not.toThrow();
  });

  it('leaves a group the borders between its own members', () => {
    const g = grid(4, 2);
    const arcs = traceArcs(g, labelsOf([[0, 0, 1, 1], [0, 0, 1, 1]]), 1);
    const rings = assembleRings(arcs, (l) => l === 0 || l === 1);
    expect(rings).toHaveLength(1);
    expect(shoelace(ringPoints(arcs, rings[0]))).toBe(80_000);
  });
});

describe('routeShares and listing', () => {
  const g = grid(10, 1), labels = labelsOf([[0, 0, 0, 0, 0, 0, 1, 1, 1, 1]]);
  const line: XY[] = [[0, 50], [1000, 50]];
  const rules = [{ minInside: 0.3, minInsideKm: 0.2 }, { minInside: 0.3, minInsideKm: 0.2 }];

  it('measures each label and lists the home area first', () => {
    const shares = routeShares(g, labels, line);
    expect(shares.total).toBeCloseTo(1000);
    expect(shares.metres.get(0)).toBeCloseTo(600);
    expect(listing(shares, rules)).toEqual([0, 1]);
  });

  it('lists another area only above its thresholds', () => {
    const shares = routeShares(g, labels, line);
    expect(listing(shares, [rules[0], { minInside: 0.3, minInsideKm: 1 }])).toEqual([0]);
    expect(listing(shares, [rules[0], { minInside: 0.5, minInsideKm: 0 }])).toEqual([0]);
  });

  it('lists nothing for a route outside the raster', () => {
    expect(listing(routeShares(g, labels, [[5000, 50], [6000, 50]]), rules)).toEqual([]);
  });
});
