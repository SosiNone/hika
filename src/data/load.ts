import { cumulativeMinutes } from '../geo/hikingTime';
import { routeClimb } from '../geo/track';
import type { Place, RegionBundle, Route } from './types';

/** A route with per-sample cumulative series derived on load. */
export interface RouteView extends Route {
  km: Float64Array;
  minutes: Float64Array;
  up: Float64Array;
  down: Float64Array;
}

export interface Trails {
  offsets: Uint32Array;
  cls: Uint8Array;
  hard: Uint8Array;
  /** Uint16 metre pairs (e, n) relative to the bbox south-west corner. */
  xy: Uint16Array;
}

export interface Region {
  bundle: RegionBundle;
  heights: Uint16Array;
  swiss: Uint16Array;
  trails: Trails;
  ortho: HTMLImageElement;
  places: Map<string, Place>;
  routes: RouteView[];
}

export async function loadRegion(id: string): Promise<Region> {
  const base = `${import.meta.env.BASE_URL}data/${id}/`;
  const bundle = (await (await fetch(`${base}region.json`)).json()) as RegionBundle;
  const [heights, swiss, trailsBuf, ortho] = await Promise.all([
    binary(`${base}terrain.u16`).then((b) => new Uint16Array(b)),
    binary(`${base}${bundle.locator.file}`).then((b) => new Uint16Array(b)),
    binary(`${base}${bundle.trails.file}`),
    image(`${base}${bundle.ortho.file}`),
  ]);
  return {
    bundle,
    heights,
    swiss,
    trails: decodeTrails(trailsBuf),
    ortho,
    places: new Map(bundle.places.map((p) => [p.id, p])),
    routes: bundle.routes.map(deriveRoute),
  };
}

async function binary(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

function image(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${url}: failed to load`));
    img.src = url;
  });
}

function decodeTrails(buf: ArrayBuffer): Trails {
  const head = new DataView(buf);
  const nLines = head.getUint32(4, true), nVerts = head.getUint32(8, true);
  const offsets = new Uint32Array(buf, 12, nLines + 1);
  const metaStart = 12 + (nLines + 1) * 4;
  const cls = new Uint8Array(buf, metaStart, nLines);
  const hard = new Uint8Array(buf, metaStart + nLines, nLines);
  const xy = new Uint16Array(buf, metaStart + Math.ceil((nLines * 2) / 4) * 4, nVerts * 2);
  return { offsets, cls, hard, xy };
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

/** Sample index at a given hiking minute (binary search on the cumulative series). */
export function indexAtMinute(r: RouteView, minute: number): number {
  let lo = 0, hi = r.minutes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.minutes[mid] < minute) lo = mid + 1; else hi = mid;
  }
  return lo;
}
