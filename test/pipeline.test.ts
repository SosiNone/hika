import { describe, expect, it } from 'vitest';
import { clipToBox, type XY } from '../src/geo/track';
import type { Place } from '../src/data/types';
import { TrailGraph } from '../scripts/lib/graph';
import { resolveRouteEnd } from '../scripts/lib/names';
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
  // Trails, with a vertex every 500 m.
  const trail = (from: number, to: number): XY[] => Array.from({ length: (to - from) / 500 + 1 }, (_, i) => [from + i * 500, 0]);
  it('walks no gap wider than MAX_GAP: the longest piece is the line', () => {
    // 3 km of trail, 4 km of lake, then 1 km of trail.
    const { line, dropped } = chain([trail(0, 3000), trail(7000, 8000)]);
    expect(line).toEqual(trail(0, 3000));
    expect(dropped).toBeCloseTo(1000);
  });
  it('walks no straight segment wider than MAX_GAP either, as a boat leg drawn into a part', () => {
    const { line, dropped } = chain([[...trail(0, 1500), ...trail(6500, 7000)]]);
    expect(line).toEqual(trail(0, 1500));
    expect(dropped).toBeCloseTo(500);
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

describe('resolveRouteEnd', () => {
  const place = (id: string, name: string, kind: Place['kind'], e: number, n: number): Place => ({ id, name, kind, e, n, alt: 1000, prio: 30 });
  const places = [
    place('lugano', 'Lugano', 'village', 2717000, 1096000),
    place('comano', 'Comano', 'village', 2718000, 1099000),
    place('pairolo', 'Capanna Pairolo', 'inn', 2725000, 1105000),
    place('urnerboden', 'Urnerboden', 'village', 2713000, 1194000),
    place('gotthard', 'Passo del San Gottardo', 'pass', 2686000, 1157000),
  ];
  const near: [number, number] = [2716000, 1100000];
  const id = (name: string) => resolveRouteEnd(places, name, near)?.id;
  it('takes the place in brackets, then the one before them', () => {
    expect(id('Lugano (Comano)')).toBe('comano');
    expect(id('Lugano (Nowhere)')).toBe('lugano');
  });
  it('spells out abbreviations', () => {
    expect(id('Cap. Pairolo')).toBe('pairolo');
    expect(id('Passo del S. Gottardo')).toBe('gotthard');
  });
  it('ignores spaces as a last resort', () => expect(id('Urner Boden')).toBe('urnerboden'));
  it('takes a generic word in brackets only as a whole name', () => {
    // "Station" would prefix-match "Station Comano"; the place before the brackets wins instead.
    const withStation = [...places, place('station', 'Station Comano', 'stop', 2716000, 1100000)];
    expect(resolveRouteEnd(withStation, 'Lugano (Station)', near)?.id).toBe('lugano');
  });
  it('finds nothing for an unknown place', () => expect(id('Atlantis')).toBeUndefined());
});
