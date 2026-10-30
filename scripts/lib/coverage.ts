/**
 * Terrain coverage of an atlas tile. swissALTI3D ends at the national border, so a tile that
 * reaches abroad has empty (0) cells there; inside Switzerland every cell should have data.
 */
import type { BBox } from '../../src/data/types';
import { insideRings, type XY } from '../../src/geo/track';

/** Empty cells of a terrain grid, and how many of them lie inside Switzerland. */
export function emptyCells(heights: Uint16Array, b: { bbox: BBox; grid: { cols: number; rows: number; cell: number }; locator: { border: number[][] } }): { empty: number; inside: number } {
  const { cols, rows, cell } = b.grid;
  const rings = b.locator.border.map((flat) => Array.from({ length: flat.length / 2 }, (_, k): XY => [flat[2 * k], flat[2 * k + 1]]));
  let empty = 0, inside = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    if (heights[j * cols + i]) continue;
    empty++;
    // Row 0 is the north edge.
    if (insideRings(rings, b.bbox[0] + (i + 0.5) * cell, b.bbox[3] - (j + 0.5) * cell)) inside++;
  }
  return { empty, inside };
}
