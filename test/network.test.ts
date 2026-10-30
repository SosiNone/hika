import { describe, expect, it } from 'vitest';
import type { XY } from '../src/geo/track';
import { TrailNetwork } from '../src/geo/network';

/** Packs lines into a window's layout (`Trails.offsets` / `xy`). */
function trails(lines: XY[][]) {
  const offsets = new Uint32Array(lines.length + 1);
  lines.forEach((l, i) => { offsets[i + 1] = offsets[i] + l.length; });
  return { offsets, xy: Uint16Array.from(lines.flat(2)) };
}

describe('TrailNetwork.distanceFrom', () => {
  // The route walks line A west to east; B branches off it at (600, 100) and runs on beyond the
  // cap; C crosses B without sharing a vertex; D starts 10 m beside the route.
  const net = new TrailNetwork(trails([
    [[100, 100], [600, 100], [1100, 100]],
    [[600, 100], [600, 400], [600, 900], [600, 2000]],
    [[100, 300], [1100, 300]],
    [[300, 110], [300, 600]],
  ]));
  const e = Array.from({ length: 101 }, (_, i) => 100 + i * 10), n = e.map(() => 100);
  const d = Array.from(net.distanceFrom(e, n, 1200));

  it('puts the vertices on the route at 0', () => {
    expect(d.slice(0, 3)).toEqual([0, 0, 0]);
  });
  it('measures branches by walking distance from the junction, capped', () => {
    expect(d.slice(3, 7)).toEqual([0, 300, 800, 1200]);
  });
  it('leaves trails that are near but not connected at the cap', () => {
    expect(d.slice(7, 9)).toEqual([1200, 1200]);
  });
  it('starts trails just beside the route at their offset', () => {
    expect(d[9]).toBeCloseTo(10);
    expect(d[10]).toBeCloseTo(500);
  });
});
