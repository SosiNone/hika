import { describe, expect, it } from 'vitest';
import { lakeCells, reliefAt, type ReliefGrid } from '../src/geo/relief';

/** A cols × rows grid of decimetres from `f(i, j)` (row 0 = north). */
function grid(cols: number, rows: number, f: (i: number, j: number) => number): Uint16Array {
  return Uint16Array.from({ length: cols * rows }, (_, k) => f(k % cols, Math.floor(k / cols)));
}

const ones = (mask: Uint8Array) => [...mask].reduce((a, b) => a + b, 0);

describe('lakeCells', () => {
  it('finds a flat block in a slope', () => {
    // A 3 × 2 lake at 400.0 m in ground that climbs 5 m per cell to the east.
    const h = grid(8, 6, (i, j) => (i >= 3 && i <= 5 && j >= 2 && j <= 3 ? 4000 : 4100 + i * 50 + j * 7));
    const lake = lakeCells(h, 8, 6);
    expect(ones(lake)).toBe(6);
    expect(lake[2 * 8 + 3]).toBe(1);
    expect(lake[3 * 8 + 5]).toBe(1);
  });

  it('ignores slopes and lone flat cells', () => {
    const slope = grid(6, 6, (i, j) => 5000 + i * 30 + j * 11);
    expect(ones(lakeCells(slope, 6, 6))).toBe(0);
    // A plus-shaped flat spot is only one cell with two equal neighbours.
    const spot = grid(5, 5, (i, j) => ((i === 2 && j >= 1 && j <= 3) || (j === 2 && i >= 1 && i <= 3) ? 6000 : 6000 + (i + j) * 40 + 3));
    expect(ones(lakeCells(spot, 5, 5))).toBe(0);
  });

  it('treats no-data cells as land, not as one flat lake', () => {
    expect(ones(lakeCells(new Uint16Array(25), 5, 5))).toBe(0);
  });
});

describe('reliefAt', () => {
  const g: ReliefGrid = { bbox: [0, 0, 4000, 2000], cols: 2, rows: 1, cell: 2000 };

  it('interpolates between cell centres', () => {
    expect(reliefAt(g, Uint16Array.from([1000, 2000]), 2000, 1000)).toBeCloseTo(150, 6);
  });

  it('skips corners without data', () => {
    expect(reliefAt(g, Uint16Array.from([1000, 0]), 2000, 1000)).toBeCloseTo(100, 6);
    expect(reliefAt(g, Uint16Array.from([0, 0]), 2000, 1000)).toBe(0);
  });
});
