import { describe, expect, it } from 'vitest';
import { clipToBox, type XY } from '../src/geo/track';
import { TrailGraph } from '../scripts/lib/graph';
import { chain } from '../scripts/lib/wanderland';

describe('chain', () => {
  it('joins shuffled, reversed parts into one line', () => {
    const parts: XY[][] = [[[20, 0], [30, 0]], [[10, 0], [0, 0]], [[10, 0], [20, 0]]];
    const { line, gaps } = chain(parts);
    expect(gaps).toBe(0);
    expect(line.map(([x]) => x)).toEqual(line[0][0] === 0 ? [0, 10, 20, 30] : [30, 20, 10, 0]);
  });
  it('reports gaps between parts', () => {
    expect(chain([[[0, 0], [10, 0]], [[60, 0], [70, 0]]]).gaps).toBeCloseTo(50);
  });
});

describe('clipToBox', () => {
  it('splits a line that leaves and re-enters the box', () => {
    const pieces = clipToBox<XY>([[-5, 5], [5, 5], [15, 5], [15, 6], [5, 6]], [0, 0, 10, 10]);
    expect(pieces).toEqual([[[0, 5], [5, 5], [10, 5]], [[10, 6], [5, 6]]]);
  });
});

describe('TrailGraph', () => {
  it('prefers the quicker path over the shorter but steeper one', () => {
    // A -> B directly climbs 300 m over 1 km; the detour is 1.4 km but gentler.
    const g = new TrailGraph([
      { id: 1, cls: 1, hard: false, pts: [[0, 0, 1000], [1000, 0, 1300]] },
      { id: 2, cls: 0, hard: false, pts: [[0, 0, 1000], [500, 500, 1150], [1000, 0, 1300]] },
    ]);
    const a = g.nearestNode(0, 0, 10), b = g.nearestNode(1000, 0, 10);
    const path = g.route(a, b)!;
    expect(path.length).toBe(3);
  });
});
