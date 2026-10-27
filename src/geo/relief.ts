/**
 * Helpers for the coarse national relief (`switzerland.u16`): Uint16 decimetres, row-major, row 0
 * at the north edge, values at cell centres, 0 = no data (beyond the national border). Pure, no
 * DOM: vitest imports this.
 */

import type { Locator } from '../data/types';

export type ReliefGrid = Pick<Locator, 'bbox' | 'cols' | 'rows' | 'cell'>;

/**
 * Bilinear relief altitude (m) at LV95 (e, n), over the corners that have data, as
 * `TerrainView.heightAt` does; 0 where no corner has data.
 */
export function reliefAt(g: ReliefGrid, heights: Uint16Array, e: number, n: number): number {
  const x = Math.min(g.cols - 1.001, Math.max(0, (e - g.bbox[0]) / g.cell - 0.5));
  const y = Math.min(g.rows - 1.001, Math.max(0, (g.bbox[3] - n) / g.cell - 0.5));
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  let sum = 0, weight = 0;
  for (const [a, b, w] of [[i, j, (1 - fx) * (1 - fy)], [i + 1, j, fx * (1 - fy)], [i, j + 1, (1 - fx) * fy], [i + 1, j + 1, fx * fy]]) {
    const v = heights[b * g.cols + a];
    if (v) { sum += v * 0.1 * w; weight += w; }
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * Lake cells of the relief, as a 0/1 mask. A lake surface is flat in the terrain model, so a cell is
 * water when at least two of its four neighbours lie within 1 dm of it, and it belongs to a group
 * of at least `minCells` such cells (a lone flat cell is more likely a plain than a lake).
 */
export function lakeCells(heights: Uint16Array, cols: number, rows: number, minCells = 2): Uint8Array {
  const flat = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const v = heights[j * cols + i];
    if (!v) continue;
    let same = 0;
    if (i > 0 && near(heights[j * cols + i - 1], v)) same++;
    if (i < cols - 1 && near(heights[j * cols + i + 1], v)) same++;
    if (j > 0 && near(heights[(j - 1) * cols + i], v)) same++;
    if (j < rows - 1 && near(heights[(j + 1) * cols + i], v)) same++;
    if (same >= 2) flat[j * cols + i] = 1;
  }
  // Keep the 4-connected groups of flat cells that are large enough.
  const lake = new Uint8Array(cols * rows), seen = new Uint8Array(cols * rows);
  for (let start = 0; start < flat.length; start++) {
    if (!flat[start] || seen[start]) continue;
    const group = [start];
    seen[start] = 1;
    for (let k = 0; k < group.length; k++) {
      const c = group[k], i = c % cols;
      for (const d of [i > 0 ? c - 1 : -1, i < cols - 1 ? c + 1 : -1, c - cols, c + cols]) {
        if (d >= 0 && d < flat.length && flat[d] && !seen[d]) { seen[d] = 1; group.push(d); }
      }
    }
    if (group.length >= minCells) for (const c of group) lake[c] = 1;
  }
  return lake;
}

const near = (a: number, b: number) => a !== 0 && Math.abs(a - b) <= 1;
