/**
 * The atlas tile grid (format 3, see AGENTS.md): square LV95 tiles keyed by their south-west
 * corner in km (`2735_1225`). Shared by the pipeline, which writes tiles, and the app, which
 * stitches the tiles around a route into one window.
 */
import type { BBox } from './types';

/** Tile edge (m). */
export const TILE = 5000;
/** Terrain cell (m): a tile is TILE_CELLS × TILE_CELLS cells. */
export const CELL = 20;
export const TILE_CELLS = TILE / CELL;
/**
 * Trail vertices in a tile are whole metres from its south-west corner plus TRAIL_BIAS, so a line
 * stored in the tile of its midpoint may reach 32 km past the tile in either direction.
 */
export const TRAIL_BIAS = 32768;
/** Terrain around a route beyond its own extent (m). */
export const WINDOW_MARGIN = 2000;
/**
 * The most tiles a window joined with a region may need: 6 × 6, against the 5 × 5 to 6 × 5 of a
 * region alone, which keeps every window within check-atlas's budget. Regions don't sit on the
 * tile grid, so a cap on area would let a 27 × 27 km window take 7 × 7 tiles.
 */
export const WINDOW_MAX_TILES = 36;

/** Key of the tile whose south-west corner is (e, n). */
export const tileKey = (e: number, n: number) => `${e / 1000}_${n / 1000}`;

/** South-west corner of the tile holding a point. */
export const tileOf = (e: number, n: number): [number, number] => [Math.floor(e / TILE) * TILE, Math.floor(n / TILE) * TILE];

export const tileBox = (e: number, n: number): BBox => [e, n, e + TILE, n + TILE];

/** South-west corners of the tiles that cover `bbox`, west to east, then south to north. */
export function tilesCovering([minE, minN, maxE, maxN]: BBox): [number, number][] {
  const out: [number, number][] = [];
  for (let n = Math.floor(minN / TILE) * TILE; n < maxN; n += TILE) {
    for (let e = Math.floor(minE / TILE) * TILE; e < maxE; e += TILE) out.push([e, n]);
  }
  return out;
}

/**
 * The terrain window that shows a route whole: its extent plus WINDOW_MARGIN, rounded out to
 * whole km. Opened from a region, it is joined with the region's box as long as that needs no
 * more than WINDOW_MAX_TILES, so the region stays in view around routes that keep near it.
 */
export function routeWindow(route: BBox, region?: BBox): BBox {
  const m = WINDOW_MARGIN, km = 1000;
  const out = (b: BBox): BBox => [Math.floor(b[0] / km) * km, Math.floor(b[1] / km) * km, Math.ceil(b[2] / km) * km, Math.ceil(b[3] / km) * km];
  const own = out([route[0] - m, route[1] - m, route[2] + m, route[3] + m]);
  if (!region) return own;
  const joined = out([Math.min(own[0], region[0]), Math.min(own[1], region[1]), Math.max(own[2], region[2]), Math.max(own[3], region[3])]);
  return tilesCovering(joined).length <= WINDOW_MAX_TILES ? joined : own;
}

/** Whether a window shows a route whole: the route's own window (`routeWindow` without a region) fits in it. */
export function covers(window: BBox, route: BBox): boolean {
  const own = routeWindow(route);
  return window[0] <= own[0] && window[1] <= own[1] && window[2] >= own[2] && window[3] >= own[3];
}

/**
 * One terrain grid over `bbox` (on the CELL grid; row 0 = north edge) from the tiles that cover
 * it. `tile` returns a decoded tile, or undefined for a tile the atlas doesn't have, whose cells
 * stay 0 (no data).
 */
export function stitchGrid(bbox: BBox, tile: (key: string) => Uint16Array | undefined): { cols: number; rows: number; heights: Uint16Array } {
  const [minE, minN, maxE, maxN] = bbox;
  if ([minE, minN, maxE, maxN].some((v) => v % CELL)) throw new Error(`window ${bbox.join(',')} is not on the ${CELL} m grid`);
  const cols = (maxE - minE) / CELL, rows = (maxN - minN) / CELL;
  const heights = new Uint16Array(cols * rows);
  for (const [te, tn] of tilesCovering(bbox)) {
    const h = tile(tileKey(te, tn));
    if (!h) continue;
    // Tile cell (i, j) lands on window cell (i + dx, j + dy); both grids have row 0 in the north.
    const dx = (te - minE) / CELL, dy = (maxN - tn - TILE) / CELL;
    const i0 = Math.max(0, -dx), i1 = Math.min(TILE_CELLS, cols - dx);
    const j0 = Math.max(0, -dy), j1 = Math.min(TILE_CELLS, rows - dy);
    for (let j = j0; j < j1; j++) heights.set(h.subarray(j * TILE_CELLS + i0, j * TILE_CELLS + i1), (j + dy) * cols + i0 + dx);
  }
  return { cols, rows, heights };
}

/**
 * Cell (m) of an area's relief (`relief/<id>.bin`): the whole area, coarse, around the window. At
 * 100 m it costs about a twentieth of the 20 m terrain, and in an overview of an area a pixel
 * spans 50–100 m anyway.
 */
export const RELIEF_CELL = 100;
/** How far an area's relief reaches beyond its extent (m): its border lies well inside, and the edge dissolves beyond it. */
export const RELIEF_MARGIN = 4000;

/** The extent of an area's relief: its own (whole km) plus `margin`, RELIEF_MARGIN unless the atlas says otherwise. */
export const reliefBox = ([w, s, e, n]: BBox, margin = RELIEF_MARGIN): BBox => [w - margin, s - margin, e + margin, n + margin];

/**
 * A coarse grid over `bbox` (on whole km; row 0 = north edge) from the tiles that cover it: each of
 * its cells, of `cell` m, is the mean of the CELL cells with data in it, rounded, and 0 where none
 * has data. `tile` is as for `stitchGrid`.
 */
export function coarseGrid(bbox: BBox, cell: number, tile: (key: string) => Uint16Array | undefined): { cols: number; rows: number; heights: Uint16Array } {
  const [minE, minN, maxE, maxN] = bbox;
  if (cell % CELL || [minE, minN, maxE, maxN].some((v) => v % cell)) throw new Error(`relief ${bbox.join(',')} is not on the ${cell} m grid`);
  const cols = (maxE - minE) / cell, rows = (maxN - minN) / cell, k = cell / CELL;
  const sum = new Float64Array(cols * rows), count = new Uint16Array(cols * rows);
  for (const [te, tn] of tilesCovering(bbox)) {
    const h = tile(tileKey(te, tn));
    if (!h) continue;
    // Tile cell (i, j) lies in coarse cell ((i + dx) / k, (j + dy) / k), rounded down; both grids
    // have row 0 in the north, and the coarse grid's lines fall on the tile's.
    const dx = (te - minE) / CELL, dy = (maxN - tn - TILE) / CELL;
    for (let j = Math.max(0, -dy); j < Math.min(TILE_CELLS, rows * k - dy); j++) {
      const row = Math.floor((j + dy) / k) * cols;
      for (let i = Math.max(0, -dx); i < Math.min(TILE_CELLS, cols * k - dx); i++) {
        const v = h[j * TILE_CELLS + i];
        if (!v) continue;
        const c = row + Math.floor((i + dx) / k);
        sum[c] += v;
        count[c]++;
      }
    }
  }
  const heights = new Uint16Array(cols * rows);
  for (let c = 0; c < heights.length; c++) if (count[c]) heights[c] = Math.round(sum[c] / count[c]);
  return { cols, rows, heights };
}
