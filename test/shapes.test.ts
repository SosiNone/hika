import { describe, expect, it } from 'vitest';
import { decodeArc, decodeRings, encodeArc, insideFlat } from '../src/data/shapes';

describe('arcs', () => {
  it('round-trip through whole decametres, delta-coded', () => {
    const pts: [number, number][] = [[2_600_000, 1_200_000], [2_600_200, 1_200_000], [2_600_200, 1_199_800]];
    const arc = encodeArc(pts);
    expect(arc).toEqual([260_000, 120_000, 20, 0, 0, -20]);
    expect(decodeArc(arc)).toEqual(pts.flat());
  });
});

describe('decodeRings', () => {
  // Two squares side by side share the arc down the middle (x = 100).
  const arcs = [
    [100, 0, 100, 100],                         // 0: the shared border, north
    [100, 100, 0, 100, 0, 0, 100, 0],           // 1: the west square's other sides
    [100, 0, 200, 0, 200, 100, 100, 100],       // 2: the east square's other sides
  ].map((flat) => decodeArc(encodeArc(Array.from({ length: flat.length / 2 }, (_, k) => [flat[2 * k], flat[2 * k + 1]] as [number, number]))));

  it('joins arcs at their shared ends, reversing where asked', () => {
    expect(decodeRings(arcs, [[0, 1]])).toEqual([[100, 0, 100, 100, 0, 100, 0, 0]]);
    expect(decodeRings(arcs, [[2, -1]])).toEqual([[100, 0, 200, 0, 200, 100, 100, 100]]);
  });

  it('fills the rings even-odd', () => {
    const west = decodeRings(arcs, [[0, 1]]);
    expect(insideFlat(west, 50, 50)).toBe(true);
    expect(insideFlat(west, 150, 50)).toBe(false);
  });
});
