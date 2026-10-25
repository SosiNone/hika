import { describe, expect, it } from 'vitest';
import { CATEGORY_ORDER, Playlist } from '../src/playlist';

const routes = [
  { id: 'l1', category: 'local' },
  { id: 'r1', category: 'regional' },
  { id: 'c1', category: 'classic' },
  { id: 'l2', category: 'local' },
  { id: 'n1', category: 'national' },
  { id: 'c2', category: 'classic' },
] as const;

/** A deterministic stand-in for Math.random. */
function seeded(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

describe('Playlist', () => {
  it('groups routes in CATEGORY_ORDER and keeps region order within a group', () => {
    const p = new Playlist([...routes]);
    expect(CATEGORY_ORDER).toEqual(['classic', 'national', 'regional', 'local']);
    expect(p.ids).toEqual(['c1', 'c2', 'n1', 'r1', 'l1', 'l2']);
    expect(p.position('n1')).toBe(3);
  });

  it('steps and wraps at both ends', () => {
    const p = new Playlist([...routes]);
    expect(p.step('c1', 1)).toBe('c2');
    expect(p.step('c1', -1)).toBe('l2');
    expect(p.step('l2', 1)).toBe('c1');
    expect(p.step('unknown', 1)).toBe('c1');
  });

  it('shuffles into a permutation that starts at the current route, and back', () => {
    const p = new Playlist([...routes]);
    p.setShuffle(true, 'r1', seeded(42));
    expect(p.ids[0]).toBe('r1');
    expect([...p.ids].sort()).toEqual(routes.map((r) => r.id).sort());
    expect(p.step(p.step('r1', 1), -1)).toBe('r1');
    p.setShuffle(false, 'r1');
    expect(p.ids).toEqual(['c1', 'c2', 'n1', 'r1', 'l1', 'l2']);
  });
});
