import { describe, expect, it } from 'vitest';
import { hitTarget, mixView, placeAt, Sway, type Rect, type Target } from '../src/hud/switzerland';

/** A target from a screen polygon, labelled at `label` (or the middle of its extent). */
const target = (kind: Target['kind'], id: string, pts: number[], label?: [number, number]): Target => {
  const xs = pts.filter((_, k) => k % 2 === 0), ys = pts.filter((_, k) => k % 2 === 1);
  const rect: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const [lx, ly] = label ?? [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
  return { kind, id, rings: [Float32Array.from(pts)], rect, lx, ly };
};

describe('hitTarget', () => {
  // An L-shaped area whose label sits in its long arm, beside a square neighbour.
  const ell = target('area', 'ell', [0, 0, 10, 0, 10, 30, 30, 30, 30, 40, 0, 40], [5, 20]);
  const square = target('area', 'square', [10, 0, 30, 0, 30, 30, 10, 30]);

  it('takes the shape that holds the point, not the nearest label', () => {
    // (25, 35) is in the foot of the L, nearer the square's label than the L's.
    expect(hitTarget([ell, square], 25, 35, 4)?.id).toBe('ell');
    expect(hitTarget([ell, square], 25, 25, 4)?.id).toBe('square');
  });

  it('prefers an area over the range around it', () => {
    const range = target('range', 'range', [-10, -10, 50, -10, 50, 50, -10, 50]);
    expect(hitTarget([range, square], 20, 10, 4)?.id).toBe('square');
    expect(hitTarget([range, square], 45, 45, 4)?.id).toBe('range');
  });

  it('gives a finger slack outside the outlines, and nothing beyond it', () => {
    expect(hitTarget([square], 33, 10, 4)?.id).toBe('square');
    expect(hitTarget([square], 36, 10, 4)).toBeNull();
  });
});

describe('placeAt', () => {
  it('centres labels on their points, inside the view', () => {
    const placed = placeAt([{ id: 'a', x: 50, y: 20, w: 40, h: 10 }, { id: 'b', x: 2, y: 2, w: 20, h: 10 }], 100, 40);
    expect(placed.get('a')).toEqual([30, 15, 70, 25]);
    expect(placed.get('b')).toEqual([0, 0, 20, 10]);
  });

  it('moves a label off one placed before it, and leaves it out if it cannot', () => {
    const items = [{ id: 'a', x: 50, y: 20, w: 40, h: 10 }, { id: 'b', x: 50, y: 20, w: 40, h: 10 }, { id: 'c', x: 50, y: 20, w: 40, h: 10 }, { id: 'd', x: 50, y: 20, w: 40, h: 10 }];
    const placed = placeAt(items, 100, 60);
    expect(placed.get('b')).toEqual([30, 4, 70, 14]);
    expect(placed.get('c')).toEqual([30, 26, 70, 36]);
    expect(placed.has('d')).toBe(false);
  });

  it('always places a forced label', () => {
    const placed = placeAt([{ id: 'a', x: 50, y: 20, w: 40, h: 10 }, { id: 'b', x: 50, y: 20, w: 40, h: 40, force: true }], 100, 40);
    expect(placed.has('b')).toBe(true);
  });
});

describe('mixView', () => {
  const a = { s: 1, u: 0, v: 0 }, b = { s: 4, u: 100, v: -50 };
  it('starts and ends on the two views', () => {
    expect(mixView(a, b, 0)).toEqual(a);
    expect(mixView(a, b, 1)).toEqual(b);
  });
  it('zooms evenly in log', () => expect(mixView(a, b, 0.5).s).toBeCloseTo(2));
});

describe('Sway', () => {
  it('starts straight and turns as it steps', () => {
    const sway = new Sway();
    expect(sway.theta).toBe(0);
    sway.step(5);
    expect(sway.theta).toBeGreaterThan(0.15);
  });

  it('holds its angle while held, then sways on from it', () => {
    const sway = new Sway();
    sway.step(5);
    const angle = sway.theta;
    sway.held = true;
    sway.step(5);
    expect(sway.theta).toBe(angle);
    sway.held = false;
    sway.step(0.1);
    expect(sway.theta).toBeGreaterThan(angle);
    expect(sway.theta - angle).toBeLessThan(0.01);
  });
});
