import { describe, expect, it } from 'vitest';
import type { BBox } from '../src/data/types';
import { insideRings } from '../src/geo/track';
import { emptyCells } from '../scripts/lib/coverage';
import { bestWindowAround, borderAdjusted, CellGrid, overlaps, rankWindows, scoreWindow } from '../scripts/lib/scout';

// A 10 × 10 km grid of 1 km cells, all inside "Switzerland" unless a test says otherwise.
const grid = () => {
  const g = new CellGrid([0, 0, 10000, 10000]);
  g.fill('inside', () => 1);
  return g;
};

describe('CellGrid', () => {
  it('sums a layer over the cells a box covers', () => {
    const g = grid();
    g.add('hut', 500, 500);
    g.add('hut', 2500, 500, 2);
    g.add('hut', 9500, 9500);
    expect(g.sum('hut', [0, 0, 3000, 1000])).toBe(3);
    expect(g.sum('hut', [0, 0, 10000, 10000])).toBe(4);
  });
  it('ignores points outside and clamps boxes to the grid', () => {
    const g = grid();
    g.add('hut', -500, 500);
    g.add('hut', 500, 500);
    expect(g.sum('hut', [-5000, -5000, 1000, 1000])).toBe(1);
  });
  it('rebuilds its sums after a change', () => {
    const g = grid();
    expect(g.sum('lake', [0, 0, 10000, 10000])).toBe(0);
    g.add('lake', 5000, 5000);
    expect(g.sum('lake', [0, 0, 10000, 10000])).toBe(1);
  });
});

describe('scoreWindow', () => {
  it('weighs mountain trails over valley trails and reports the share inside', () => {
    const g = grid();
    g.fill('inside', (e) => (e < 5000 ? 1 : 0));
    g.add('berg', 500, 500, 10);
    g.add('wander', 600, 600, 10);
    const w = scoreWindow(g, [0, 0, 10000, 10000]);
    expect(w.score).toBeCloseTo(10 + 3);
    expect(w.inside).toBeCloseTo(0.5);
    expect(borderAdjusted(w)).toBe(0);
  });
});

describe('overlaps', () => {
  it('treats shared edges as apart', () => expect(overlaps([0, 0, 10, 10], [10, 0, 20, 10])).toBe(false));
  it('detects a partial overlap', () => expect(overlaps([0, 0, 10, 10], [9, 9, 20, 20])).toBe(true));
});

describe('bestWindowAround', () => {
  const g = grid();
  g.add('hut', 8500, 8500, 5);

  it('moves towards the better ground', () => {
    const [minE, minN, maxE, maxN] = bestWindowAround(g, [5000, 5000], [4000, 4000], { reach: 3000 })!.bbox;
    expect(minE <= 8500 && 8500 <= maxE && minN <= 8500 && 8500 <= maxN).toBe(true);
  });
  it('keeps the include points inside the margin', () => {
    const w = bestWindowAround(g, [5000, 5000], [4000, 4000], { reach: 3000, include: [[3000, 3000]], margin: 500 })!;
    expect(w.bbox[0]).toBeLessThanOrEqual(2500);
    expect(w.bbox[1]).toBeLessThanOrEqual(2500);
  });
  it('avoids existing regions', () => {
    const avoid: BBox[] = [[6000, 6000, 10000, 10000]];
    expect(overlaps(bestWindowAround(g, [5000, 5000], [4000, 4000], { reach: 3000, avoid })!.bbox, avoid[0])).toBe(false);
  });
});

describe('rankWindows', () => {
  it('returns the best boxes without overlaps', () => {
    const g = grid();
    g.add('hut', 1500, 1500, 3);
    g.add('hut', 8500, 8500, 2);
    const ranked = rankWindows(g, [3000, 3000], { count: 2 });
    expect(ranked.map((w) => w.score)).toEqual([6, 4]);
    expect(overlaps(ranked[0].bbox, ranked[1].bbox)).toBe(false);
  });
});

describe('emptyCells', () => {
  // 4 × 2 cells of 10 m over [0, 0, 40, 20]; the border runs down the middle (x = 20).
  const b = { bbox: [0, 0, 40, 20] as BBox, grid: { cols: 4, rows: 2, cell: 10, minAlt: 0, maxAlt: 0 }, locator: { border: [[0, 0, 20, 0, 20, 20, 0, 20]] } } as Parameters<typeof emptyCells>[1];

  it('accepts empty cells abroad', () => expect(emptyCells(Uint16Array.of(5, 5, 0, 0, 5, 5, 0, 0), b)).toEqual({ empty: 4, inside: 0 }));
  it('flags empty cells inside Switzerland', () => expect(emptyCells(Uint16Array.of(0, 5, 0, 0, 5, 5, 5, 5), b)).toEqual({ empty: 3, inside: 1 }));
});

describe('insideRings', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6]] as [number, number][];
  it('finds points inside a ring', () => expect(insideRings([square], 5, 1)).toBe(true));
  it('treats a nested ring as a hole', () => expect(insideRings([square, hole], 5, 5)).toBe(false));
  it('rejects points outside', () => expect(insideRings([square], 11, 5)).toBe(false));
});
