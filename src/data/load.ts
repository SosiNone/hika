import { cumulativeMinutes } from '../geo/hikingTime';
import { routeClimb } from '../geo/track';
import { decodeGrid, decodeTrails, type Trails } from './codec';
import { BUNDLE_VERSION, type Place, type RegionBundle, type RegionIndex, type Route } from './types';

export type { Trails };

/** A route with per-sample cumulative series derived on load. */
export interface RouteView extends Route {
  km: Float64Array;
  minutes: Float64Array;
  up: Float64Array;
  down: Float64Array;
}

export interface Region {
  bundle: RegionBundle;
  heights: Uint16Array;
  swiss: Uint16Array;
  trails: Trails;
  places: Map<string, Place>;
  routes: RouteView[];
}

/** The regions the app offers (public/data/regions.json). */
export function loadRegionIndex(): Promise<RegionIndex> {
  return json<RegionIndex>(`${import.meta.env.BASE_URL}data/regions.json`);
}

export async function loadRegion(id: string): Promise<Region> {
  const base = `${import.meta.env.BASE_URL}data/${id}/`;
  const bundle = await json<RegionBundle>(`${base}region.json`);
  if (bundle.version !== BUNDLE_VERSION) throw new Error(`${id}: bundle format ${bundle.version}, but this app reads ${BUNDLE_VERSION}; rebuild it with \`task region REGION=${id}\``);
  const { grid } = bundle;
  const [heights, swiss, trailsBuf] = await Promise.all([
    binary(`${base}${grid.file}`).then((b) => decodeGrid(new Uint8Array(b), grid.cols, grid.rows)),
    binary(`${base}${bundle.locator.file}`).then((b) => new Uint16Array(b)),
    binary(`${base}${bundle.trails.file}`),
  ]);
  return {
    bundle,
    heights,
    swiss,
    trails: decodeTrails(trailsBuf),
    places: new Map(bundle.places.map((p) => [p.id, p])),
    routes: bundle.routes.map(deriveRoute),
  };
}

const prefetched = new Set<string>();

/**
 * Warms the HTTP cache with another region's bundle, so opening it (a page load) is quicker: its
 * region.json, then prefetch hints for the files it names. Once per region, and never when the
 * browser asks to save data.
 */
export function prefetchRegion(id: string) {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (prefetched.has(id) || connection?.saveData) return;
  prefetched.add(id);
  const base = `${import.meta.env.BASE_URL}data/${id}/`;
  fetch(`${base}region.json`, { priority: 'low' } as RequestInit)
    .then((res) => (res.ok ? (res.json() as Promise<RegionBundle>) : null))
    .then((bundle) => {
      if (bundle?.version !== BUNDLE_VERSION) return;
      for (const file of [bundle.grid.file, bundle.trails.file, bundle.locator.file]) {
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = `${base}${file}`;
        document.head.appendChild(link);
      }
    })
    .catch(() => prefetched.delete(id));
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function binary(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

function deriveRoute(r: Route): RouteView {
  const km = Float64Array.from(r.alt, (_, i) => (i * r.step) / 1000);
  const { up, down } = routeClimb(r.alt);
  return { ...r, km, minutes: cumulativeMinutes(r.alt, r.step), up, down };
}

/**
 * The same route walked to → from. Samples are evenly spaced, so reversing the arrays is exact;
 * times and climbs come from the same helpers as the forward direction.
 */
export function reverseRoute(r: Route): RouteView {
  const flip = <T>(a: T[]) => [...a].reverse();
  const view = deriveRoute({
    ...r,
    from: r.to,
    to: r.from,
    clipped: [r.clipped[1], r.clipped[0]],
    e: flip(r.e), n: flip(r.n), alt: flip(r.alt), cls: flip(r.cls), surf: flip(r.surf),
  });
  const last = r.alt.length - 1;
  view.stats = { ...r.stats, time: r.stats.timeBack, timeBack: r.stats.time, up: Math.round(view.up[last]), down: Math.round(view.down[last]) };
  view.waypoints = flip(r.waypoints).map((w) => {
    const i = last - Math.min(last, Math.round((w.km * 1000) / r.step));
    return { ...w, km: Math.round((i * r.step) / 100) / 10, time: Math.round(view.minutes[i]) };
  });
  return view;
}

/** Index of the first waypoint still ahead of sample `i`, or -1 once the hiker has arrived. */
export function nextWaypoint(r: Pick<Route, 'waypoints' | 'step'>, i: number): number {
  return r.waypoints.findIndex((w) => w.km * 1000 > i * r.step + 1);
}

/** Sample index at a given hiking minute (binary search on the cumulative series). */
export function indexAtMinute(r: RouteView, minute: number): number {
  let lo = 0, hi = r.minutes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.minutes[mid] < minute) lo = mid + 1; else hi = mid;
  }
  return lo;
}
