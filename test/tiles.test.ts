import { describe, expect, it } from 'vitest';
import { covers, routeWindow, stitchGrid, TILE, TILE_CELLS, tileKey, tileOf, tilesCovering } from '../src/data/tiles';
import type { BBox } from '../src/data/types';

describe('tile grid', () => {
  it('keys tiles by their south-west corner in km', () => {
    expect(tileKey(2735000, 1225000)).toBe('2735_1225');
    expect(tileOf(2739999, 1225000)).toEqual([2735000, 1225000]);
    expect(tileOf(2740000, 1229999.9)).toEqual([2740000, 1225000]);
  });
  it('covers a box with whole tiles, west to east, then south to north', () => {
    // Alpstein: 22 × 19 km, not on the 5 km grid; its north edge (1246 km) takes a fifth row.
    const keys = tilesCovering([2736000, 1227000, 2758000, 1246000]).map(([e, n]) => tileKey(e, n));
    expect(keys.length).toBe(5 * 5);
    expect(keys.slice(0, 2)).toEqual(['2735_1225', '2740_1225']);
    expect(keys[keys.length - 1]).toBe('2755_1245');
    // A box that ends on a tile edge does not take the next tile.
    expect(tilesCovering([2735000, 1225000, 2740000, 1230000])).toEqual([[2735000, 1225000]]);
  });
  it('frames a route with a margin, joined with its region and rounded out to whole km', () => {
    const route: BBox = [2740500, 1230200, 2745100, 1233900];
    expect(routeWindow(route)).toEqual([2738000, 1228000, 2748000, 1236000]);
    expect(routeWindow(route, [2736000, 1227000, 2758000, 1246000])).toEqual([2736000, 1227000, 2758000, 1246000]);
  });
  it('keeps a route window on its own where joining its region would make it too large', () => {
    // A 20 km stage leaving the Alpstein box to the south-west.
    const route: BBox = [2716000, 1210000, 2736000, 1230000];
    expect(routeWindow(route, [2736000, 1227000, 2758000, 1246000])).toEqual([2714000, 1208000, 2738000, 1232000]);
  });
});

describe('covers', () => {
  const route: BBox = [2740500, 1230200, 2745100, 1233900];
  it('holds a route whose own window fits', () => expect(covers([2736000, 1227000, 2758000, 1246000], route)).toBe(true));
  it('does not hold one that comes within the margin of an edge', () => expect(covers([2739000, 1227000, 2758000, 1246000], route)).toBe(false));
});

describe('stitching', () => {
  // A cell's value is a function of its column and row within a 2 × 2 block of tiles, so seams show.
  const value = (col: number, row: number) => 1 + ((col * 7 + row * 131) % 60000);
  const tiles = new Map<string, Uint16Array>();
  for (const [e, n] of tilesCovering([0, 0, 2 * TILE, 2 * TILE])) {
    tiles.set(tileKey(e, n), Uint16Array.from({ length: TILE_CELLS ** 2 }, (_, k) => {
      const col = e / TILE * TILE_CELLS + (k % TILE_CELLS), row = (1 - n / TILE) * TILE_CELLS + Math.floor(k / TILE_CELLS);
      return value(col, row);
    }));
  }
  const at = (g: { cols: number; heights: Uint16Array }, i: number, j: number) => g.heights[j * g.cols + i];

  it('joins tiles without a seam, row 0 in the north', () => {
    const g = stitchGrid([0, 0, 2 * TILE, 2 * TILE], (k) => tiles.get(k));
    expect([g.cols, g.rows]).toEqual([2 * TILE_CELLS, 2 * TILE_CELLS]);
    expect(g.heights).toEqual(Uint16Array.from({ length: g.cols * g.rows }, (_, k) => value(k % g.cols, Math.floor(k / g.cols))));
  });
  it('crops a window across tile edges', () => {
    // 2 km east of the west edge, 3 km south of the north edge.
    const g = stitchGrid([2000, 1000, 8000, 7000], (k) => tiles.get(k));
    expect([g.cols, g.rows]).toEqual([300, 300]);
    expect(at(g, 0, 0)).toBe(value(100, 150));
    expect(at(g, 299, 299)).toBe(value(399, 449));
  });
  it('leaves missing tiles empty', () => {
    const g = stitchGrid([0, 0, 2 * TILE, TILE], (k) => (k === '0_0' ? tiles.get(k) : undefined));
    expect(at(g, 0, 0)).toBe(value(0, 250));
    expect(at(g, 250, 0)).toBe(0);
  });
  it('refuses a window off the cell grid', () => expect(() => stitchGrid([5, 0, 1000, 1000], () => undefined)).toThrow(/20 m grid/));
});
