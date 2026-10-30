/** Turns a route line into samples, heights, trail classes, stats and waypoints (build-atlas). */
import { OFF_NETWORK, type Place, type Route, type RouteStats, type Waypoint } from '../../src/data/types';
import { cumulativeMinutes, MAX_SLOPE, smoothAltitudes } from '../../src/geo/hikingTime';
import { resample, routeClimb, type XY } from '../../src/geo/track';
import { profileHeights } from './profile';
import type { SegmentIndex, TrailLine } from './trails';

/** Metres between route samples. */
export const STEP = 10;

export type RouteMeta = Pick<Route, 'id' | 'number' | 'name' | 'from' | 'to' | 'source' | 'category'>;

export interface RouteContext {
  /** Places a waypoint may name. A route that starts or ends away from any adds a place of its own here. */
  places: Place[];
  /** Trail lookup for the class and surface of each sample. */
  segments: SegmentIndex;
  /** Terrain height (m, NaN without data) where the profile service has none. */
  heightAt: (e: number, n: number) => number;
}

/** A route sampled every STEP metres, in LV95. */
export interface Sampled {
  pts: XY[];
  alt: number[];
  cls: number[];
  surf: number[];
  stats: RouteStats;
  waypoints: Waypoint[];
}

export const round1 = (v: number) => Math.round(v * 10) / 10;

/** Samples a route every STEP metres and derives heights, trail class, stats and waypoints. */
export async function finishRoute(meta: RouteMeta, line: XY[], ctx: RouteContext, viaIds: string[] = []): Promise<Sampled> {
  const pts = resample(line, STEP);
  const alt = (await profileHeights(pts)).map((h, i) => (Number.isNaN(h) ? ctx.heightAt(pts[i][0], pts[i][1]) : h));
  const cls: number[] = [], surf: number[] = [];
  for (const [e, n] of pts) {
    const t: TrailLine | undefined = ctx.segments.nearest(e, n, 15);
    cls.push(t ? t.cls : OFF_NETWORK);
    surf.push(t?.hard ? 1 : 0);
  }
  const minutes = cumulativeMinutes(alt, STEP);
  const back = cumulativeMinutes([...alt].reverse(), STEP);
  const smooth = smoothAltitudes(alt, 3);
  const climbed = routeClimb(alt);
  const up = climbed.up[climbed.up.length - 1], down = climbed.down[climbed.down.length - 1];
  const classKm: [number, number, number, number] = [0, 0, 0, 0];
  let hard = 0, steep = 0;
  for (let i = 1; i < pts.length; i++) {
    const km = STEP / 1000;
    classKm[cls[i] === OFF_NETWORK ? 3 : cls[i]] += km;
    if (surf[i]) hard += km;
    if (Math.abs(smooth[i] - smooth[i - 1]) / STEP * 100 > MAX_SLOPE) steep += km;
  }
  const km = ((pts.length - 1) * STEP) / 1000;
  return {
    pts,
    alt,
    cls,
    surf,
    stats: {
      km: round1(km), up: Math.round(up), down: Math.round(down),
      time: Math.round(minutes[minutes.length - 1]), timeBack: Math.round(back[back.length - 1]),
      minAlt: Math.round(Math.min(...alt)), maxAlt: Math.round(Math.max(...alt)),
      classKm: classKm.map(round1) as [number, number, number, number], hardKm: round1(hard), steepKm: round1(steep),
    },
    waypoints: waypointsAlong(pts, alt, minutes, viaIds, meta, ctx.places),
  };
}

/**
 * Places a hiker passes: summits, passes, inns, stops, viewpoints and lakes near the route,
 * thinned so that within 250 m along the route only the most important one is kept.
 */
function waypointsAlong(pts: XY[], alt: number[], minutes: Float64Array, viaIds: string[], meta: Pick<Route, 'id' | 'from' | 'to'>, places: Place[]): Waypoint[] {
  const reach: Partial<Record<Place['kind'], number>> = { summit: 60, pass: 60, inn: 80, stop: 80, lift: 80, view: 60, lake: 350, water: 60, cave: 40, village: 120 };
  const hits: { p: Place; i: number }[] = [];
  for (const p of places) {
    const max = reach[p.kind];
    if (max === undefined || (p.kind === 'village' && p.prio < 30)) continue;
    let bi = -1, bd = max;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - p.e, pts[i][1] - p.n);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0) hits.push({ p, i: bi });
  }
  const forced = new Set(viaIds);
  hits.sort((a, b) => Number(forced.has(b.p.id)) - Number(forced.has(a.p.id)) || b.p.prio - a.p.prio);
  const kept: { p: Place; i: number }[] = [];
  for (const h of hits) if (forced.has(h.p.id) || !kept.some((k) => Math.abs(k.i - h.i) * STEP < 250)) kept.push(h);
  kept.sort((a, b) => a.i - b.i);
  // Every route gets a departure and an arrival: the nearest named place, or one named after the route's end.
  for (const end of [0, 1] as const) {
    const i = end ? pts.length - 1 : 0;
    const have = end ? kept[kept.length - 1] : kept[0];
    if (have && Math.abs(have.i - i) * STEP <= 300) continue;
    const [e, n] = pts[i];
    const near = places
      .map((p) => ({ p, d: Math.hypot(p.e - e, p.n - n) }))
      .filter((x) => x.d < 600)
      .sort((a, b) => a.d - b.d)[0]?.p;
    const p = near ?? { id: `${meta.id}-${end ? 'end' : 'start'}`, name: end ? meta.to : meta.from, kind: 'village' as const, e, n, alt: Math.round(alt[i]), prio: 0 };
    if (!near) places.push(p);
    if (end) kept.push({ p, i }); else kept.unshift({ p, i });
  }
  return kept.map(({ p, i }) => ({ place: p.id, km: round1((i * STEP) / 1000), alt: Math.round(alt[i]), time: Math.round(minutes[i]) }));
}

/** The checks every stored route must pass; empty when it does. */
export function routeProblems(r: Pick<Route, 'e' | 'n' | 'alt' | 'cls' | 'surf' | 'step' | 'stats' | 'waypoints'>): string[] {
  const n = r.e.length, problems: string[] = [];
  if (![r.n, r.alt, r.cls, r.surf].every((a) => a.length === n)) problems.push('sample arrays differ in length');
  // Switzerland spans 193 m (Lago Maggiore) to 4634 m (Dufourspitze).
  if (!r.alt.every((a) => a > 185 && a < 4700)) problems.push('altitude outside 185–4700 m');
  const stepKm = ((n - 1) * r.step) / 1000;
  // Between 6.7 and 1 km/h.
  if (!(r.stats.time > stepKm * 9 && r.stats.time < stepKm * 60)) problems.push(`${r.stats.time} min for ${stepKm.toFixed(1)} km`);
  // The app re-derives climb on load; the stored totals must match what it will show.
  const { up, down } = routeClimb(r.alt);
  if (Math.abs(up[n - 1] - r.stats.up) > 1 || Math.abs(down[n - 1] - r.stats.down) > 1) problems.push(`climb ↑${r.stats.up} ↓${r.stats.down} drifts from routeClimb`);
  if (r.waypoints.length < 2) problems.push('fewer than 2 waypoints');
  return problems;
}
