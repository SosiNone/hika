import { describe, expect, it } from 'vitest';
import { clipRings, decodeArc, decodeRings, encodeArc, insideFlat, rasterizeRings, smoothRing } from '../src/data/shapes';

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

// An L of 2 × 2 km with a 200 m hole in its foot, in LV95.
const L = [
  [2_600_000, 1_200_000, 2_602_000, 1_200_000, 2_602_000, 1_201_000, 2_601_000, 1_201_000, 2_601_000, 1_202_000, 2_600_000, 1_202_000],
  [2_600_400, 1_200_400, 2_600_600, 1_200_400, 2_600_600, 1_200_600, 2_600_400, 1_200_600],
];

describe('rasterizeRings', () => {
  it('marks the cells whose centre insideFlat puts inside, row 0 at the north', () => {
    const box: [number, number, number, number] = [2_599_500, 1_199_500, 2_602_500, 1_202_500];
    const { cols, rows, mask } = rasterizeRings(L, box, 100);
    expect([cols, rows]).toEqual([30, 30]);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const inside = insideFlat(L, box[0] + (c + 0.5) * 100, box[3] - (r + 0.5) * 100);
      expect(mask[r * cols + c]).toBe(inside ? 255 : 0);
    }
    // The hole, the corner the L leaves out, and its foot and arm.
    expect(mask[20 * cols + 10]).toBe(0);
    expect(mask[8 * cols + 22]).toBe(0);
    expect(mask[24 * cols + 10]).toBe(255);
    expect(mask[8 * cols + 8]).toBe(255);
  });
});

describe('clipRings', () => {
  it('keeps the parts within the box, with a point every step', () => {
    const lines = clipRings([L[0]], [2_600_500, 1_199_000, 2_603_000, 1_203_000], 50);
    for (const line of lines) for (let k = 0; k < line.length; k += 2) {
      expect(line[k]).toBeGreaterThanOrEqual(2_600_500);
      if (k) expect(Math.hypot(line[k] - line[k - 2], line[k + 1] - line[k - 1])).toBeLessThanOrEqual(50.001);
    }
    // The ring leaves the box twice: from the foot's south side up the top of the arm, in one piece.
    expect(lines).toHaveLength(1);
    expect(lines[0].slice(0, 2)).toEqual([2_600_500, 1_200_000]);
    expect(lines[0].slice(-2)).toEqual([2_600_500, 1_202_000]);
  });

  it('closes a ring that lies wholly inside', () => {
    const [line] = clipRings([L[1]], [2_600_000, 1_200_000, 2_601_000, 1_201_000], 100);
    expect(line.slice(0, 2)).toEqual(line.slice(-2));
    expect(line).toHaveLength((8 + 1) * 2);
  });
});

describe('smoothRing', () => {
  it('cuts corners, keeps straight stretches and stays near the ring', () => {
    const square = [0, 0, 400, 0, 400, 400, 0, 400];
    const once = smoothRing(square, 1);
    expect(once).toEqual([100, 0, 300, 0, 400, 100, 400, 300, 300, 400, 100, 400, 0, 300, 0, 100]);
    const twice = smoothRing(square, 2);
    expect(twice).toHaveLength(square.length * 4);
    expect(Math.min(...twice)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...twice)).toBeLessThanOrEqual(400);
    expect(insideFlat([twice], 200, 200)).toBe(true);
    expect(insideFlat([twice], 10, 10)).toBe(false);
  });
});
