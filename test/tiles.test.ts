import { describe, expect, it } from 'vitest';
import { coarseGrid, covers, RELIEF_CELL, RELIEF_MARGIN, reliefBox, routeWindow, stitchGrid, TILE, TILE_CELLS, tileKey, tileOf, tilesCovering } from '../src/data/tiles';
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

describe('area reliefs', () => {
  it('reach RELIEF_MARGIN beyond the area', () => {
    expect(reliefBox([2_740_000, 1_225_000, 2_760_000, 1_240_000])).toEqual([2_740_000 - RELIEF_MARGIN, 1_225_000 - RELIEF_MARGIN, 2_760_000 + RELIEF_MARGIN, 1_240_000 + RELIEF_MARGIN]);
    expect(reliefBox([0, 0, 1000, 1000], 2000)).toEqual([-2000, -2000, 3000, 3000]);
  });

  it('average the cells with data in each coarse cell, north row first, across tiles', () => {
    // Two tiles side by side: the west one rises to the north (row j holds 1000 + 250 - j dm), the
    // east one is flat at 500 dm with a hole of no data in its north-west corner.
    const west = new Uint16Array(TILE_CELLS * TILE_CELLS), east = new Uint16Array(TILE_CELLS * TILE_CELLS).fill(500);
    for (let j = 0; j < TILE_CELLS; j++) west.fill(1000 + TILE_CELLS - j, j * TILE_CELLS, (j + 1) * TILE_CELLS);
    for (let j = 0; j < 5; j++) east.fill(0, j * TILE_CELLS, j * TILE_CELLS + 5);
    for (let j = 5; j < 10; j++) east.fill(0, j * TILE_CELLS, j * TILE_CELLS + 3);
    const tiles = new Map([[tileKey(2_600_000, 1_200_000), west], [tileKey(2_605_000, 1_200_000), east]]);
    // 9 × 5 km from 1 km into the west tile, over the east one and 1 km beyond it (no tile there).
    const { cols, rows, heights } = coarseGrid([2_601_000, 1_200_000, 2_611_000, 1_205_000], RELIEF_CELL, (k) => tiles.get(k));
    expect([cols, rows]).toEqual([100, 50]);
    const k = RELIEF_CELL / (TILE / TILE_CELLS);
    // West: the mean of rows 0–4 is 1000 + 250 − 2.
    expect(heights[0]).toBe(1248);
    expect(heights[49 * cols]).toBe(1000 + TILE_CELLS - (49 * k + 2));
    // East: no data at all in the corner, then a cell with 15 of its 25 empty.
    expect(heights[40]).toBe(0);
    expect(heights[cols + 40]).toBe(500);
    expect(heights[cols + 41]).toBe(500);
    // Beyond the east tile.
    expect(heights[cols - 1]).toBe(0);
  });

  it('refuse a box off their grid', () => {
    expect(() => coarseGrid([2_601_050, 1_200_000, 2_602_000, 1_201_000], RELIEF_CELL, () => undefined)).toThrow();
  });
});
