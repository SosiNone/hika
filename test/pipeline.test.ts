import { describe, expect, it } from 'vitest';
import { clipToBox, type XY } from '../src/geo/track';
import type { BBox, Place, Waypoint } from '../src/data/types';
import { emptyCells } from '../scripts/lib/coverage';
import { TrailGraph } from '../scripts/lib/graph';
import { mergeNames, resolvePlace, resolveRouteEnd, type PlaceRow } from '../scripts/lib/names';
import { routeProblems, waypointsAlong } from '../scripts/lib/route';
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

describe('mergeNames', () => {
  // rank: 0 official endonym, 1 official exonym, 2 customary or informal endonym, 3 their exonym.
  const row = (id: string, name: string, rank: number, e = 2746884): PlaceRow => ({ id, name, kind: 'pass', e, n: 1233503, alt: 2011, prio: 60, rank });

  it('leaves a place with one name as it is, with no field beyond a stored place', () => {
    expect(mergeNames([row('a', 'Hohe Winde', 0)])).toEqual([{ id: 'a', name: 'Hohe Winde', kind: 'pass', e: 2746884, n: 1233503, alt: 2011, prio: 60 }]);
  });
  it('makes one place of the rows of one id, in the order they first came', () => {
    const merged = mergeNames([row('a', 'Zwinglipass', 0), row('b', 'Other', 0, 2700000), row('a', 'Chreialppass', 0)]);
    expect(merged.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('takes the first of equally good names, and keeps the others', () => {
    const [p] = mergeNames([row('a', 'Zwinglipass', 0), row('a', 'Chreialppass', 0)]);
    expect(p.name).toBe('Zwinglipass');
    expect(p.also).toEqual(['Chreialppass']);
  });
  it('prefers the better name, wherever the file lists it', () => {
    const [p] = mergeNames([row('a', 'Ginevra', 3), row('a', 'Genf', 3), row('a', 'Genève', 0)]);
    expect(p.name).toBe('Genève');
    expect(p.also).toEqual(['Ginevra', 'Genf']);
  });
  it('still finds a place by a name it does not go by', () => {
    const places = mergeNames([row('a', 'Zwinglipass', 0), row('a', 'Chreialppass', 0)]);
    expect(resolvePlace(places, 'Chreialppass', [2746884, 1233503])?.name).toBe('Zwinglipass');
    expect(resolvePlace(places, 'Zwinglipass', [2746884, 1233503])?.id).toBe('a');
  });
});

describe('waypointsAlong', () => {
  const STEP = 10, meta = { id: 'r', from: 'A', to: 'B' };
  /** A line east along n = 0, every 10 m. */
  const walk = (metres: number) => Array.from({ length: metres / STEP + 1 }, (_, i): XY => [i * STEP, 0]);
  const along = (pts: XY[], via: string[], places: Place[]) =>
    waypointsAlong(pts, pts.map(() => 1000), Float64Array.from(pts, (_, i) => i), via, meta, places);
  const place = (id: string, name: string, e: number, n = 0): Place => ({ id, name, kind: 'pass', e, n, alt: 1000, prio: 60 });

  it('names a via place with two names once, under one name', () => {
    const rows = [{ ...place('p', 'Zwinglipass', 500), rank: 0 }, { ...place('p', 'Chreialppass', 500), rank: 0 }];
    const places = [place('a', 'A', 0), ...mergeNames(rows), place('b', 'B', 1000)];
    const w = along(walk(1000), ['a', 'p', 'b'], places);
    expect(w.map((x) => x.place)).toEqual(['a', 'p', 'b']);
    expect(routeProblems(stored(w))).toEqual([]);
  });
  it('names the start of a loop at both ends, 11 km apart', () => {
    // Out 5.5 km along n = 0, back along n = 20: the start lies nearest both ends of the line.
    const out = walk(5500), back = [...walk(5500)].reverse().map(([e]): XY => [e, 20]);
    const w = along([...out, ...back], [], [place('home', 'Home', 0, 10)]);
    expect(w.map((x) => x.place)).toEqual(['home', 'home']);
    expect(w.map((x) => x.km)).toEqual([0, 11]);
    expect(routeProblems(stored(w))).toEqual([]);
  });
});

describe('routeProblems', () => {
  it('flags a place twice at one km', () => {
    const w = [{ place: 'a', km: 0, alt: 1000, time: 0 }, { place: 'p', km: 0.5, alt: 1000, time: 6 }, { place: 'p', km: 0.5, alt: 1000, time: 6 }, { place: 'b', km: 1, alt: 1000, time: 12 }];
    expect(routeProblems(stored(w))).toEqual(['waypoint p twice at km 0.5']);
  });
  it('takes a place at two points of the route', () => {
    const w = [{ place: 'home', km: 0, alt: 1000, time: 0 }, { place: 'hut', km: 0.5, alt: 1000, time: 6 }, { place: 'home', km: 1, alt: 1000, time: 12 }];
    expect(routeProblems(stored(w))).toEqual([]);
  });
});

/** A flat 1 km route that passes every other check of `routeProblems`, with these waypoints. */
function stored(waypoints: Waypoint[]) {
  const zeros = Array.from({ length: 101 }, () => 0);
  return { e: zeros, n: zeros, alt: zeros.map(() => 1000), cls: zeros, surf: zeros, step: 10, waypoints, stats: { km: 1, up: 0, down: 0, time: 14, timeBack: 14, minAlt: 1000, maxAlt: 1000, classKm: [1, 0, 0, 0] as [number, number, number, number], hardKm: 0, steepKm: 0 } };
}

describe('emptyCells', () => {
  // 4 × 2 cells of 10 m over [0, 0, 40, 20]; the border runs down the middle (x = 20).
  const b = { bbox: [0, 0, 40, 20] as BBox, grid: { cols: 4, rows: 2, cell: 10, minAlt: 0, maxAlt: 0 }, locator: { border: [[0, 0, 20, 0, 20, 20, 0, 20]] } } as Parameters<typeof emptyCells>[1];

  it('accepts empty cells abroad', () => expect(emptyCells(Uint16Array.of(5, 5, 0, 0, 5, 5, 0, 0), b)).toEqual({ empty: 4, inside: 0 }));
  it('flags empty cells inside Switzerland', () => expect(emptyCells(Uint16Array.of(0, 5, 0, 0, 5, 5, 5, 5), b)).toEqual({ empty: 3, inside: 1 }));
});
