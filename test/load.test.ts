import { describe, expect, it } from 'vitest';
import { nextWaypoint, reverseRoute, waypointId, waypointPins } from '../src/data/load';
import type { Route, Waypoint } from '../src/data/types';

describe('waypointId', () => {
  const at = (place: string, km: number): Waypoint => ({ place, km, alt: 0, time: 0 });
  const ids = (r: Pick<Route, 'waypoints'>) => r.waypoints.map((_, k) => waypointId(r, k));

  it('labels the ends and numbers the points between', () => {
    expect(ids({ waypoints: [at('a', 0), at('b', 1), at('c', 2), at('d', 3)] })).toEqual(['DEP', 'P1', 'P2', 'ARR']);
  });
  it('gives a route of only its ends DEP and ARR', () => {
    expect(ids({ waypoints: [at('a', 0), at('b', 1)] })).toEqual(['DEP', 'ARR']);
  });
  it('tells apart the ends of a loop, which name one place', () => {
    expect(ids({ waypoints: [at('home', 0), at('hut', 5), at('home', 11)] })).toEqual(['DEP', 'P1', 'ARR']);
  });
  it('tells apart a place the route passes twice', () => {
    expect(ids({ waypoints: [at('a', 0), at('pass', 2), at('hut', 3), at('pass', 4), at('b', 6)] })).toEqual(['DEP', 'P1', 'P2', 'P3', 'ARR']);
  });
  it('follows the walking direction on a reversed route', () => {
    const alt = Array.from({ length: 301 }, (_, i) => 1000 + i);
    const zeros = alt.map(() => 0);
    const r = reverseRoute({
      id: 'x', number: null, name: '', from: 'home', to: 'home', source: 'curated', category: 'classic', step: 10, e: zeros, n: zeros, alt, cls: zeros, surf: zeros,
      stats: { km: 3, up: 300, down: 0, time: 60, timeBack: 50, minAlt: 1000, maxAlt: 1300, classKm: [3, 0, 0, 0], hardKm: 0, steepKm: 0 },
      waypoints: [at('home', 0), at('hut', 1), at('home', 3)],
    });
    expect(r.waypoints.map((w, k) => `${waypointId(r, k)} ${w.place}`)).toEqual(['DEP home', 'P1 hut', 'ARR home']);
  });
});

describe('waypointPins', () => {
  const route = (...places: string[]) => ({ waypoints: places.map((place, k) => ({ place, km: k, alt: 0, time: 0 })) });

  it('pins every waypoint of a route between two places', () => {
    expect(waypointPins(route('a', 'b', 'c'))).toEqual([{ k: 0, id: 'DEP' }, { k: 1, id: 'P1' }, { k: 2, id: 'ARR' }]);
  });
  it('gives the ends of a loop one pin, at the finish', () => {
    expect(waypointPins(route('home', 'hut', 'lake', 'home'))).toEqual([{ k: 1, id: 'P1' }, { k: 2, id: 'P2' }, { k: 3, id: 'DEP/ARR' }]);
  });
  it('gives a loop of only its ends that one pin', () => {
    expect(waypointPins(route('home', 'home'))).toEqual([{ k: 1, id: 'DEP/ARR' }]);
  });
  it('keeps a place passed twice between the ends as two pins', () => {
    expect(waypointPins(route('a', 'pass', 'hut', 'pass', 'b')).map((p) => p.id)).toEqual(['DEP', 'P1', 'P2', 'P3', 'ARR']);
  });
});

describe('nextWaypoint', () => {
  // 10 m samples; waypoints at 0, 1.5 and 3 km.
  const r = { step: 10, waypoints: [0, 1.5, 3].map((km, k) => ({ place: `p${k}`, km, alt: 0, time: 0 })) };

  it('counts the departure as passed from the first sample', () => expect(nextWaypoint(r, 0)).toBe(1));
  it('keeps a waypoint next until the hiker reaches it', () => expect(nextWaypoint(r, 149)).toBe(1));
  it('moves on once the hiker stands on it', () => expect(nextWaypoint(r, 150)).toBe(2));
  it('returns -1 on arrival', () => expect(nextWaypoint(r, 300)).toBe(-1));
});
