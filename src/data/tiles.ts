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
