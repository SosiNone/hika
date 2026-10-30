/** Shape of a generated region bundle (public/data/<region>/region.json + binaries). */

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
  /** Whether the route continues beyond the region at its start / end. */
  clipped: [boolean, boolean];
  /** Metres between samples. */
  step: number;
  /** Sample coordinates in metres relative to the bbox south-west corner. */
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
  name: string;
  owner: string;
  url: string;
}

/** Bundle format the app reads: 2 stores terrain.bin and trails.bin delta-encoded (src/data/codec.ts). */
export const BUNDLE_VERSION = 2;

export interface RegionBundle {
  version: typeof BUNDLE_VERSION;
  id: string;
  title: string;
  subtitle: string;
  cantons: string[];
  bbox: BBox;
  /**
   * terrain.bin (`encodeGrid`): row-major, row 0 at the north edge, cell centres, decimetres;
   * 0 = no data.
   */
  grid: { file: string; cols: number; rows: number; cell: number; minAlt: number; maxAlt: number };
  trails: { file: string; lines: number; vertices: number; km: [number, number, number]; hardKm: number };
  places: Place[];
  routes: Route[];
  locator: Locator;
  sources: Source[];
  generated: string;
}

export interface Locator {
  /** switzerland.u16: coarse national relief as raw Uint16 decimetres (small, and the same file in every bundle). */
  file: string;
  bbox: BBox;
  cols: number;
  rows: number;
  cell: number;
  /** Simplified national border and canton borders as flat [e0, n0, e1, n1, …] LV95 rings. */
  border: number[][];
  cantons: number[][];
}

/** public/data/regions.json: every built region, written by the pipeline (scripts/lib/regions.ts). */
export interface RegionIndex {
  version: 2;
  /** Sorted by title. */
  regions: RegionSummary[];
}

export interface RegionSummary {
  id: string;
  title: string;
  subtitle: string;
  cantons: string[];
  bbox: BBox;
  /** Route id selected when a link names no route (or one the region doesn't have). */
  defaultRoute: string;
  routes: number;
  /** How many of the routes are curated hikes (classics). */
  classics: number;
  /** Signposted network in the box, km per class (Wanderweg, Bergwanderweg, Alpinwanderweg). */
  trailKm: [number, number, number];
  /** Lowest and highest terrain in the box (m). */
  alt: [number, number];
}

export interface RegionConfig {
  id: string;
  title: string;
  subtitle: string;
  cantons: string[];
  bbox: BBox;
  /** Route id (`sm-…` or `c-…`) to open by default; the first curated hike otherwise. */
  defaultRoute?: string;
  cell: number;
  /**
   * List official routes only with at least this share of their length (or these km) inside the
   * bbox: the bundle drops the others, the atlas leaves them out of this region's list.
   */
  minInside: number;
  minInsideKm: number;
  /** SchweizMobil ids to leave out of the bundle, and of the atlas altogether (e.g. a route abroad). */
  excludeRoutes: string[];
  curated: CuratedHike[];
}

export interface CuratedHike {
  id: string;
  name: string;
  /** Waypoint names resolved through swissNAMES3D; `kind` or `near` disambiguate. */
  via: { name: string; kind?: PlaceKind; near?: [number, number] }[];
}

/**
 * Atlas (format 3): the national tiled store that replaces region bundles (AGENTS.md, "Atlas").
 * Its tiles are laid out by src/data/tiles.ts. Unlike a bundle, everything is in absolute LV95.
 */
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
export interface AtlasRoute extends Omit<Route, 'clipped' | 'e' | 'n'> {
  /** Sample coordinates in LV95 metres (to 0.1 m). */
  e: number[];
  n: number[];
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

export const SPARK_POINTS = 24;
