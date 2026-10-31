/**
 * The national partition into areas, from the data: the border (swissBOUNDARIES3D), the area
 * outlines and places of swissNAMES3D, a 200 m terrain model of swissALTI3D, and the seeds of
 * regions/*.json. scripts/lib/partition.ts does the work; build-atlas and preview-regions call this.
 */
import type { Place, RegionConfig } from '../../src/data/types';
import { lakeCells } from '../../src/geo/relief';
import type { XY } from '../../src/geo/track';
import { CH_BBOX, loadBoundaries } from './locator';
import { loadAreaFeatures, matchAreaFeatures, resolvePlace, type AreaFeature } from './names';
import {
  assembleRings, cleanIslands, fillDisc, fillGaps, fillRings, growAreas, labelPoints, majority, MIN_PIECE_KM2, paintSeeds, raster,
  traceArcs, type Arc, type Raster, type SeedPart,
} from './partition';
import { encodeU16, nationalDem, type Grid } from './terrain';

/** Cell of the partition raster (m). */
export const AREA_CELL = 200;
/** Area borders are simplified to this (m); diagonal steps of the 200 m raster are under it, so they straighten. */
export const ARC_TOLERANCE = 150;
/** A place or point seeds a disc this wide (m) unless it says otherwise. */
const SEED_RADIUS = 1500;
/** Flat groups of fewer 200 m cells than this (1 km²) are plains, not lakes. */
const LAKE_CELLS = 25;

/**
 * The mountain ranges: swisstopo's Grossregionen, which tile Switzerland, keyed by an official
 * name. Their order is the one the app lists them in, roughly west to east and north to south.
 */
export const RANGES = [
  { id: 'jura', title: 'Jura', name: 'Jura' },
  { id: 'mittelland', title: 'Swiss Plateau', name: 'Mittelland' },
  { id: 'voralpen', title: 'Prealps', name: 'Voralpen' },
  { id: 'waadtlaender-alpen', title: 'Vaud Alps', name: 'Waadtländer Alpen' },
  { id: 'berner-alpen', title: 'Bernese Alps', name: 'Berner Alpen' },
  { id: 'walliser-alpen', title: 'Valais Alps', name: 'Walliser Alpen' },
  { id: 'urner-alpen', title: 'Uri Alps', name: 'Urner Alpen' },
  { id: 'glarner-alpen', title: 'Glarus Alps', name: 'Glarner Alpen' },
  { id: 'lepontinische-alpen', title: 'Lepontine Alps', name: 'Lepontinische Alpen' },
  { id: 'raetische-alpen', title: 'Rhaetian Alps', name: 'Rätische Alpen' },
] as const;

export interface Partition {
  grid: Raster;
  /** Area index (into `configs`) per cell, −1 outside Switzerland. */
  labels: Int16Array;
  /** The areas, sorted by id; a label is an index into them. */
  configs: RegionConfig[];
  /** Every name of each range, official ones first. */
  rangeNames: string[][];
  /** Range index per area, and the share of the area inside that range's swisstopo outline. */
  areaRange: number[];
  rangeShare: number[];
  /** Points well inside each area and range, for labels. */
  areaLabels: XY[];
  rangeLabels: XY[];
  km2: number[];
  /** Every border once, and each area's and range's rings as references to them (`assembleRings`). */
  arcs: Arc[];
  areaRings: number[][][];
  rangeRings: number[][][];
  /** Area parts kept apart from the area's main part. */
  exclaves: { area: number; km2: number; at: XY }[];
  /** The other names of each area's seed outlines (the language variants), for search. */
  seedNames: string[][];
  dem: Grid;
}

/** Partitions Switzerland into the areas of `configs` (any order; they come back sorted by id). */
export async function buildPartition(configs: RegionConfig[], places: Place[], log: (msg: string) => void = () => {}): Promise<Partition> {
  configs = [...configs].sort((a, b) => a.id.localeCompare(b.id));
  const ids = configs.map((c) => c.id);
  const g = raster(CH_BBOX, AREA_CELL), size = g.cols * g.rows;
  const { border } = await loadBoundaries();
  const mask = new Uint8Array(size);
  fillRings(g, border, mask, 1);
  log(`partition: ${g.cols}×${g.rows} cells of ${AREA_CELL} m, terrain model`);
  const dem = await nationalDem(border, AREA_CELL);
  const lake = lakeCells(encodeU16(dem.data), g.cols, g.rows, LAKE_CELLS);
  const features = await loadAreaFeatures();

  // Ranges from the Grossregion outlines; lakes and slivers they leave out go to the nearest.
  const ranges = new Int16Array(size).fill(-1);
  const rangeNames: string[][] = RANGES.map(() => []);
  for (const f of features.filter((f) => f.kind === 'Grossregion')) {
    const r = RANGES.findIndex((range) => f.names.includes(range.name));
    if (r < 0) throw new Error(`swissNAMES3D Grossregion ${f.names.join(' / ')} is not in RANGES`);
    fillRings(g, f.rings, ranges, r);
    for (const n of f.names) if (!rangeNames[r].includes(n)) rangeNames[r].push(n);
  }
  const missing = RANGES.filter((_, r) => !rangeNames[r].length).map((r) => r.name);
  if (missing.length) throw new Error(`no swissNAMES3D Grossregion for ${missing.join(', ')}`);
  fillGaps(g, ranges, mask);

  // Seeds.
  const parts: SeedPart[] = [];
  const seedNames: string[][] = configs.map(() => []);
  const scratch = new Int16Array(size).fill(-1);
  const take = (area: number, fill: (out: Int16Array) => void) => {
    fill(scratch);
    const cells: number[] = [];
    for (let c = 0; c < size; c++) if (scratch[c] >= 0) { cells.push(c); scratch[c] = -1; }
    parts.push({ area, cells });
  };
  configs.forEach((cfg, area) => {
    const outlines = cfg.seeds.flatMap((s) => ('name' in s ? [resolveSeed(features, cfg.id, s)] : [])).flat();
    const anchor = outlines.length ? centre(outlines.flatMap((f) => f.rings.flat())) : centre(border.flat());
    for (const s of cfg.seeds) {
      if ('name' in s) continue;
      const at = 'at' in s ? s.at : resolveSeedPlace(places, cfg.id, s.place, s.near ?? anchor, s.kind);
      if ('place' in s) log(`  ${cfg.id}: seed ${s.place} at ${at.map(Math.round).join(', ')}`);
      take(area, (out) => fillDisc(g, at[0], at[1], s.radius ?? SEED_RADIUS, out, area));
    }
    for (const f of outlines) {
      take(area, (out) => fillRings(g, f.rings, out, area));
      for (const n of f.names) if (!seedNames[area].includes(n)) seedNames[area].push(n);
    }
  });
  const seeds = paintSeeds(g, parts, mask, ids);

  log('partition: growing the areas by hiking time');
  const labels = growAreas(g, dem.data, mask, lake, seeds);
  fillGaps(g, labels, mask);
  const exclaves = cleanIslands(g, labels, Math.round((MIN_PIECE_KM2 * 1e6) / AREA_CELL ** 2));

  const majorityRange = majority(labels, ranges, configs.length, RANGES.length);
  const areaRange = configs.map((cfg, a) => {
    if (!cfg.range) return majorityRange[a];
    const r = RANGES.findIndex((range) => range.id === cfg.range);
    if (r < 0) throw new Error(`${cfg.id}: unknown range ${cfg.range}`);
    return r;
  });
  const empty = RANGES.filter((_, r) => !areaRange.includes(r)).map((r) => r.id);
  if (empty.length) throw new Error(`no area belongs to ${empty.join(', ')}`);
  const cellsOf = new Array<number>(configs.length).fill(0), inRange = new Array<number>(configs.length).fill(0);
  for (let c = 0; c < size; c++) {
    const a = labels[c];
    if (a < 0) continue;
    cellsOf[a]++;
    if (ranges[c] === areaRange[a]) inRange[a]++;
  }

  const byRange = Int16Array.from(labels, (a) => (a < 0 ? -1 : areaRange[a]));
  const arcs = traceArcs(g, labels, ARC_TOLERANCE);
  return {
    grid: g, labels, configs, rangeNames, areaRange,
    rangeShare: cellsOf.map((n, a) => (n ? inRange[a] / n : 0)),
    areaLabels: labelPoints(g, labels, configs.length),
    rangeLabels: labelPoints(g, byRange, RANGES.length),
    km2: cellsOf.map((n) => (n * AREA_CELL ** 2) / 1e6),
    arcs,
    areaRings: configs.map((_, a) => assembleRings(arcs, (l) => l === a)),
    rangeRings: RANGES.map((_, r) => assembleRings(arcs, (l) => l >= 0 && areaRange[l] === r)),
    exclaves: exclaves.map((x) => ({ area: x.area, km2: (x.cells * AREA_CELL ** 2) / 1e6, at: [g.bbox[0] + ((x.at % g.cols) + 0.5) * AREA_CELL, g.bbox[3] - (Math.floor(x.at / g.cols) + 0.5) * AREA_CELL] })),
    seedNames, dem,
  };
}

/** The outlines a name seed means: every feature with that name (and kind), or the one nearest `near`. */
function resolveSeed(features: AreaFeature[], id: string, s: { name: string; kind?: AreaFeature['kind']; near?: [number, number] }): AreaFeature[] {
  const found = matchAreaFeatures(features.filter((f) => f.kind !== 'Grossregion'), s.name, s.kind);
  if (!found.length) {
    const hint = features.filter((f) => f.names.some((n) => n.toLowerCase().includes(s.name.toLowerCase().slice(0, 5)))).map((f) => `${f.names[0]} (${f.kind})`);
    throw new Error(`${id}: no swissNAMES3D area named "${s.name}"${s.kind ? ` of kind ${s.kind}` : ''}${hint.length ? `; similar: ${hint.join(', ')}` : ''}`);
  }
  const kinds = new Set(found.map((f) => f.kind));
  if (kinds.size > 1) throw new Error(`${id}: "${s.name}" is a ${[...kinds].join(' and a ')}; give its kind`);
  if (!s.near) return found;
  const [e, n] = s.near;
  return [found.reduce((best, f) => (dist(f, e, n) < dist(best, e, n) ? f : best))];
}

function resolveSeedPlace(places: Place[], id: string, name: string, near: [number, number], kind?: Place['kind']): [number, number] {
  const p = resolvePlace(places, name, near, kind);
  if (!p) throw new Error(`${id}: cannot resolve seed place "${name}"`);
  return [p.e, p.n];
}

const centre = (pts: XY[]): [number, number] => {
  let [minE, minN, maxE, maxN] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [e, n] of pts) { minE = Math.min(minE, e); minN = Math.min(minN, n); maxE = Math.max(maxE, e); maxN = Math.max(maxN, n); }
  return [(minE + maxE) / 2, (minN + maxN) / 2];
};

const dist = (f: AreaFeature, e: number, n: number) => { const [x, y] = centre(f.rings.flat()); return Math.hypot(x - e, y - n); };
