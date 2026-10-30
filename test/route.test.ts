import { describe, expect, it } from 'vitest';
import { reverseRoute } from '../src/data/load';
import type { Route } from '../src/data/types';
import { cumulativeMinutes } from '../src/geo/hikingTime';

// A 2 km climb of 400 m followed by a flat kilometre, sampled every 10 m.
const STEP = 10, N = 301;
const alt = Array.from({ length: N }, (_, i) => 1000 + Math.min(i, 200) * 2);
const minutes = cumulativeMinutes(alt, STEP);
const back = cumulativeMinutes([...alt].reverse(), STEP);
const route: Route = {
  id: 'c-test', number: null, name: 'Test', from: 'Valley', to: 'Ridge', source: 'curated', category: 'classic',
  step: STEP,
  e: alt.map((_, i) => i * STEP), n: alt.map(() => 0), alt,
  cls: alt.map((_, i) => (i < 100 ? 0 : 1)), surf: alt.map((_, i) => (i < 20 ? 1 : 0)),
  stats: {
    km: 3, up: 400, down: 0, time: Math.round(minutes[N - 1]), timeBack: Math.round(back[N - 1]),
    minAlt: 1000, maxAlt: 1400, classKm: [1, 2, 0, 0], hardKm: 0.2, steepKm: 0,
  },
  waypoints: [
    { place: 'valley', km: 0, alt: 1000, time: 0 },
    { place: 'hut', km: 1, alt: 1200, time: Math.round(minutes[100]) },
    { place: 'ridge', km: 3, alt: 1400, time: Math.round(minutes[N - 1]) },
  ],
};

describe('reverseRoute', () => {
  const r = reverseRoute(route);

  it('mirrors the samples and swaps the ends', () => {
    expect(r.alt).toEqual([...alt].reverse());
    expect(r.e[0]).toBe(route.e[N - 1]);
    expect(r.cls[0]).toBe(1);
    expect(r.surf[N - 1]).toBe(1);
    expect([r.from, r.to]).toEqual(['Ridge', 'Valley']);
    expect(r.id).toBe(route.id);
  });

  it('walks downhill in the reverse time', () => {
    expect(r.stats.time).toBe(route.stats.timeBack);
    expect(r.stats.timeBack).toBe(route.stats.time);
    expect(Math.round(r.minutes[N - 1])).toBe(route.stats.timeBack);
    expect(r.stats.up).toBe(Math.round(r.up[N - 1]));
    expect(r.stats.down).toBeGreaterThan(390);
    expect(r.stats.up).toBe(0);
  });

  it('reverses the waypoints with mirrored distances and new times', () => {
    expect(r.waypoints.map((w) => w.place)).toEqual(['ridge', 'hut', 'valley']);
    expect(r.waypoints.map((w) => w.km)).toEqual([0, 2, 3]);
    expect(r.waypoints[0].time).toBe(0);
    expect(r.waypoints[1].time).toBe(Math.round(r.minutes[200]));
    expect(r.waypoints[2].time).toBe(route.stats.timeBack);
  });

  it('round-trips', () => {
    const rr = reverseRoute(r);
    expect(rr.alt).toEqual(route.alt);
    expect(rr.e).toEqual(route.e);
    expect(rr.waypoints).toEqual(route.waypoints);
    expect([rr.from, rr.to]).toEqual([route.from, route.to]);
  });
});
