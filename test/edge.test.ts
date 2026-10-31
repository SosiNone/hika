import { describe, expect, it } from 'vitest';
import { CORNER, edgeMask, REACH } from '../src/gl/edge';
import { WINDOW_MARGIN } from '../src/data/tiles';

/** A 16 × 12 km window from 500 to 2500 m. */
const size: [number, number] = [16000, 12000];
const alts: [number, number] = [500, 2500];

describe('edgeMask', () => {
  it('keeps the terrain whole where a route can be', () => {
    expect(REACH).toBeLessThanOrEqual(WINDOW_MARGIN);
    expect(CORNER).toBeLessThanOrEqual(WINDOW_MARGIN);
    // Anywhere WINDOW_MARGIN inside the window, at any altitude: along the sides and at a corner.
    for (const alt of [500, 1500, 2500]) {
      for (let x = -6000; x <= 6000; x += 250) {
        expect(edgeMask(x, 4000, alt, size, alts)).toBe(1);
        expect(edgeMask(x, -4000, alt, size, alts)).toBe(1);
      }
      expect(edgeMask(6000, 4000, alt, size, alts)).toBe(1);
      expect(edgeMask(0, 0, alt, size, alts)).toBe(1);
    }
  });

  it('is gone at the edge of the window and beyond its rounded corners', () => {
    for (const alt of [500, 1500, 2500]) {
      for (let x = -8000; x <= 8000; x += 250) {
        expect(edgeMask(x, 6000, alt, size, alts)).toBe(0);
        expect(edgeMask(x, -6000, alt, size, alts)).toBe(0);
      }
      expect(edgeMask(7900, 5900, alt, size, alts)).toBe(0);
    }
  });

  it('frays the outline, and lets ridges reach further out than valleys', () => {
    // How far in from the north edge of a 40 km window the terrain is half there, along that edge.
    const wide: [number, number] = [40000, 40000];
    const outline = (alt: number) => Array.from({ length: 121 }, (_, k) => {
      let d = 0;
      while (edgeMask(-15000 + k * 250, -20000 + d, alt, wide, alts) < 0.5) d += 10;
      return d;
    });
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const mid = outline(1500);
    expect(Math.max(...mid) - Math.min(...mid)).toBeGreaterThan(600);
    expect(mean(outline(2500))).toBeLessThan(mean(mid) - 200);
    expect(mean(mid)).toBeLessThan(mean(outline(500)) - 200);
  });

  it('is the same terrain edge every time', () => {
    expect(edgeMask(-7400, 1234, 1800, size, alts)).toBe(edgeMask(-7400, 1234, 1800, size, alts));
  });
});
