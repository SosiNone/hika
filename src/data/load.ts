import { cumulativeMinutes } from '../geo/hikingTime';
import { clipToBox, routeClimb, type XY } from '../geo/track';
import { decodeGrid, decodeRoute, decodeTrails, type Trails } from './codec';
import { CELL, routeWindow, stitchGrid, TILE_CELLS, TRAIL_BIAS, tileKey, tilesCovering } from './tiles';
import { ATLAS_FORMAT, type AtlasManifest, type AtlasRoute, type BBox, type Catalogue, type CatalogueEntry, type Locator, type Place, type RegionIndex, type RegionSummary, type Route } from './types';

export type { Trails };

/** A route with per-sample cumulative series derived on load. */
export interface RouteView extends Route {
  km: Float64Array;
  minutes: Float64Array;
  up: Float64Array;
  down: Float64Array;
}

/** What the app loads once: everything in the atlas but its tiles and route files. */
export interface Atlas {
  manifest: AtlasManifest;
  /** Keys of the tiles the atlas has. */
  tiles: Set<string>;
  catalogue: Map<string, CatalogueEntry>;
  regions: RegionSummary[];
  locator: Locator;
  /** The coarse national relief (`locator.file`). */
  swiss: Uint16Array;
}

/** The terrain, trails and places of one window, stitched from the tiles that cover it. */
export interface TerrainWindow {
  bbox: BBox;
  grid: { cols: number; rows: number; cell: number; minAlt: number; maxAlt: number };
  /** Row-major Uint16 decimetres, row 0 at the north edge, 0 = no data. */
  heights: Uint16Array;
  /** Clipped to the window, vertices in whole metres from its south-west corner. */
  trails: Trails;
  places: Place[];
}

/** The region a page shows: its routes, the places they name, and the window around the selected route. */
export interface Region {
  summary: RegionSummary;
  routes: RouteView[];
  /** Every place a route of the region names. */
  places: Map<string, Place>;
  /** Replaced when the selected route leaves it (`loadWindow`). */
  window: TerrainWindow;
}

export async function loadAtlas(): Promise<Atlas> {
  const manifest = await json<AtlasManifest>('manifest.json');
  if (manifest.format !== ATLAS_FORMAT) throw new Error(`the atlas at ${__DATA_URL__} is format ${manifest.format}, but this app reads ${ATLAS_FORMAT}`);
  const [catalogue, index, locator] = await Promise.all([json<Catalogue>('catalogue.json'), json<RegionIndex>('regions.json'), json<Locator>('locator.json')]);
  return {
    manifest,
    tiles: new Set(manifest.tiles),
    catalogue: new Map(catalogue.routes.map((r) => [r.id, r])),
    regions: index.regions,
    locator,
    swiss: new Uint16Array(await binary(locator.file)),
  };
}

/** The routes a region lists, from their files, and the places they name. */
export async function loadRoutes(atlas: Atlas, region: RegionSummary): Promise<{ routes: RouteView[]; places: Map<string, Place> }> {
  const files = await Promise.all([...atlas.catalogue.values()].filter((r) => r.regions.includes(region.id)).map((r) => loadRoute(r.id)));
  const places = new Map<string, Place>();
  for (const f of files) for (const p of f.places) places.set(p.id, p);
  return { routes: files.map(({ places: _, ...r }) => deriveRoute(r)), places };
}

const routes = new Map<string, Promise<AtlasRoute>>();

function loadRoute(id: string): Promise<AtlasRoute> {
  let r = routes.get(id);
  if (!r) {
    r = binary(`routes/${id}.bin`).then(decodeRoute);
    r.catch(() => routes.delete(id));
    routes.set(id, r);
  }
  return r;
}

interface Tile { heights: Uint16Array; trails: Trails; places: Place[] }
/** Tiles fetched on this page, decoded; neighbouring windows share most of theirs. */
const tiles = new Map<string, Promise<Tile>>();

function loadTile(key: string): Promise<Tile> {
  let t = tiles.get(key);
  if (!t) {
    t = Promise.all([binary(`terrain/${key}.bin`), binary(`trails/${key}.bin`), json<Place[]>(`places/${key}.json`)])
      .then(([h, tr, places]) => ({ heights: decodeGrid(new Uint8Array(h), TILE_CELLS, TILE_CELLS), trails: decodeTrails(tr), places }));
    t.catch(() => tiles.delete(key));
    tiles.set(key, t);
  }
  return t;
}

const keysOf = (atlas: Atlas, bbox: BBox) => tilesCovering(bbox).map(([e, n]) => tileKey(e, n)).filter((k) => atlas.tiles.has(k));

/**
 * One window of terrain (on whole km): the tiles that cover it, stitched and cropped. Trail lines
 * are clipped to it, so their vertices fit the window's Uint16 metres.
 */
export async function loadWindow(atlas: Atlas, bbox: BBox): Promise<TerrainWindow> {
  const loaded = await Promise.all(keysOf(atlas, bbox).map(async (key) => [key, await loadTile(key)] as const));
  const byKey = new Map(loaded);
  const { cols, rows, heights } = stitchGrid(bbox, (key) => byKey.get(key)?.heights);
  let minAlt = Infinity, maxAlt = -Infinity;
  for (const v of heights) if (v) { if (v < minAlt) minAlt = v; if (v > maxAlt) maxAlt = v; }
  const [minE, minN, maxE, maxN] = bbox;
  const offsets = [0], cls: number[] = [], hard: number[] = [], xy: number[] = [];
  for (const [key, t] of loaded) {
    const [te, tn] = key.split('_').map((v) => +v * 1000);
    const { offsets: o, cls: c, hard: h, xy: v } = t.trails;
    for (let l = 0; l < c.length; l++) {
      const line: XY[] = [];
      for (let k = o[l]; k < o[l + 1]; k++) line.push([te + v[2 * k] - TRAIL_BIAS, tn + v[2 * k + 1] - TRAIL_BIAS]);
      for (const piece of clipToBox(line, bbox)) {
        for (const [e, n] of piece) xy.push(Math.round(e - minE), Math.round(n - minN));
        offsets.push(xy.length / 2);
        cls.push(c[l]);
        hard.push(h[l]);
      }
    }
  }
  return {
    bbox,
    // A window without any data (all abroad) is flat at sea level.
    grid: { cols, rows, cell: CELL, minAlt: Number.isFinite(minAlt) ? Math.round(minAlt / 10) : 0, maxAlt: Number.isFinite(maxAlt) ? Math.round(maxAlt / 10) : 1 },
    heights,
    trails: { offsets: Uint32Array.from(offsets), cls: Uint8Array.from(cls), hard: Uint8Array.from(hard), xy: Uint16Array.from(xy) },
    places: loaded.flatMap(([, t]) => t.places.filter((p) => p.e >= minE && p.e <= maxE && p.n >= minN && p.n <= maxN)),
  };
}

/** Starts fetching a window's tiles, so switching to it later is quick. */
export function prefetchWindow(atlas: Atlas, bbox: BBox) {
  for (const key of keysOf(atlas, bbox)) loadTile(key).catch(() => {});
}

const prefetched = new Set<string>();

/**
 * Warms the HTTP cache for another region (opening it is a page load): the tiles of the window it
 * opens with and its route files, as prefetch hints. Once per region, and never when the browser
 * asks to save data.
 */
export function prefetchRegion(atlas: Atlas, id: string) {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const region = atlas.regions.find((r) => r.id === id), first = region && atlas.catalogue.get(region.defaultRoute);
  if (prefetched.has(id) || connection?.saveData || !region || !first) return;
  prefetched.add(id);
  const files = keysOf(atlas, routeWindow(first.bbox, region.bbox)).flatMap((k) => [`terrain/${k}.bin`, `trails/${k}.bin`, `places/${k}.json`]);
  for (const r of atlas.catalogue.values()) if (r.regions.includes(id)) files.push(`routes/${r.id}.bin`);
  for (const file of files) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = `${__DATA_URL__}${file}`;
    document.head.appendChild(link);
  }
}

async function fetchOk(rel: string): Promise<Response> {
  const res = await fetch(`${__DATA_URL__}${rel}`);
  if (!res.ok) throw new Error(`${__DATA_URL__}${rel}: HTTP ${res.status}`);
  return res;
}

const json = async <T>(rel: string) => (await (await fetchOk(rel)).json()) as T;
const binary = async (rel: string) => (await fetchOk(rel)).arrayBuffer();

export function deriveRoute(r: Route): RouteView {
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
