/**
 * The data the pipeline writes and the app reads: the atlas (format 3, see AGENTS.md), a national
 * store of tiles laid out by src/data/tiles.ts, routes, a catalogue and the regions. Everything in
 * it is in absolute LV95 (EPSG:2056) metres.
 */

/** LV95 [minE, minN, maxE, maxN] in metres. */
export type BBox = [number, number, number, number];

/** swissTLM3D hiking trail class: Wanderweg (yellow), Bergwanderweg (white-red-white), Alpinwanderweg (white-blue-white). */
export const TRAIL_CLASSES = ['Wanderweg', 'Bergwanderweg', 'Alpinwanderweg'] as const;
export type TrailClass = 0 | 1 | 2;
/** Route samples further than this from any trail segment are marked off-network. */
export const OFF_NETWORK = 255;

export type PlaceKind = 'summit' | 'pass' | 'lake' | 'inn' | 'stop' | 'lift' | 'view' | 'water' | 'cave' | 'village' | 'ridge';

export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  e: number;
  n: number;
  alt: number;
  /** Label priority, higher wins when labels collide. */
  prio: number;
}

export type RouteCategory = 'national' | 'regional' | 'local' | 'classic';

export interface Waypoint {
  place: string;
  km: number;
  alt: number;
  /** Cumulative hiking minutes from the start. */
  time: number;
}

export interface RouteStats {
  km: number;
  up: number;
  down: number;
  /** Hiking minutes in route direction and reversed. */
  time: number;
  timeBack: number;
  minAlt: number;
  maxAlt: number;
  /** Kilometres per trail class (index = TrailClass), plus off-network. */
  classKm: [number, number, number, number];
  hardKm: number;
  /** Kilometres steeper than ±40 %, where the Swiss time model is extrapolated. */
  steepKm: number;
}

export interface Route {
  id: string;
  /** SchweizMobil route number such as "3.03" or "951"; null for curated hikes. */
  number: string | null;
  name: string;
  from: string;
  to: string;
  source: 'schweizmobil' | 'curated';
  category: RouteCategory;
  /** Metres between samples. */
  step: number;
  /** Sample coordinates in LV95 metres (to 0.1 m). */
  e: number[];
  n: number[];
  /** swissALTI3D (DTM2) altitude per sample from the geo.admin.ch profile service. */
  alt: number[];
  cls: number[];
  /** 1 = hard surface (asphalt, concrete), 0 = natural. */
  surf: number[];
  stats: RouteStats;
  waypoints: Waypoint[];
}

export interface Source {
  /** Dataset title. */
  name: string;
  owner: string;
  /** The dataset itself, which its terms ask a credit to link to. */
  url: string;
  /** Its terms of use. */
  terms: string;
}

export const ATLAS_FORMAT = 3;

/** v3/manifest.json */
export interface AtlasManifest {
  format: typeof ATLAS_FORMAT;
  /** Tile edge and terrain cell (m). */
  tile: number;
  cell: number;
  /** Keys of the tiles present, sorted; each has a terrain/, trails/ and places/ file. */
  tiles: string[];
  /** Route count (catalogue.json lists them). */
  routes: number;
  sources: Source[];
  generated: string;
}

/** routes/<id>.bin (`encodeRoute`): one whole route, never clipped. */
export interface AtlasRoute extends Route {
  /** The places its waypoints name, so a route can be shown without the place tiles. */
  places: Place[];
}

/** v3/catalogue.json: every route, enough to list and search them without the route files. */
export interface Catalogue {
  format: typeof ATLAS_FORMAT;
  /** Sorted by id. */
  routes: CatalogueEntry[];
}

export interface CatalogueEntry extends Pick<Route, 'id' | 'number' | 'name' | 'from' | 'to' | 'source' | 'category' | 'stats'> {
  /** LV95 extent of the samples, whole metres. */
  bbox: BBox;
  /** Altitudes (m) at SPARK_POINTS evenly spaced samples, for sparklines. */
  spark: number[];
  /** Regions whose route list includes it (their `minInside` rules). */
  regions: string[];
}

/** v3/locator.json, with the coarse national relief in v3/switzerland.u16. */
export interface Locator {
  /** The relief as raw Uint16 decimetres. */
  file: string;
  bbox: BBox;
  cols: number;
  rows: number;
  cell: number;
  /** Simplified national border and canton borders as flat [e0, n0, e1, n1, …] LV95 rings. */
  border: number[][];
  cantons: number[][];
}

/** v3/regions.json: the regions, curated entry points into the atlas (scripts/lib/regions.ts). */
export interface RegionIndex {
  version: 3;
  /** Sorted by title. */
  regions: RegionSummary[];
}

export interface RegionSummary {
  id: string;
  title: string;
  subtitle: string;
  cantons: string[];
  bbox: BBox;
  /** Route id selected when a link names no route (or one the region doesn't list). */
  defaultRoute: string;
  routes: number;
  /** How many of the routes are curated hikes (classics). */
  classics: number;
  /** Signposted network in the box, km per class (Wanderweg, Bergwanderweg, Alpinwanderweg). */
  trailKm: [number, number, number];
  /** Of it, km on a hard surface. */
  hardKm: number;
  /** Lowest and highest terrain in the box (m). */
  alt: [number, number];
}

/** regions/<id>.json: a region as written by hand; build-atlas reads it. */
export interface RegionConfig {
  id: string;
  title: string;
  subtitle: string;
  cantons: string[];
  bbox: BBox;
  /** Route id (`sm-…` or `c-…`) to open by default; the first curated hike otherwise. */
  defaultRoute?: string;
  /** List an official route only with at least this share of its length (and these km) inside the bbox. */
  minInside: number;
  minInsideKm: number;
  /** SchweizMobil ids to leave out of the atlas altogether (e.g. a route abroad). */
  excludeRoutes: string[];
  curated: CuratedHike[];
}

export interface CuratedHike {
  id: string;
  name: string;
  /** Waypoint names resolved through swissNAMES3D; `kind` or `near` disambiguate. */
  via: { name: string; kind?: PlaceKind; near?: [number, number] }[];
}

export const SPARK_POINTS = 24;
