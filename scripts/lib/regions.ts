/**
 * v4/regions.json: the ranges and the areas the app offers, with the facts the region browser shows
 * and the outlines it draws. build-atlas writes it and check-atlas checks it.
 */
import type { ArcRings, BBox, CatalogueEntry, RangeSummary, RegionConfig, RegionIndex, RegionSummary } from '../../src/data/types';

/** What an area holds, measured by build-atlas. */
export interface RegionFacts {
  /** Signposted network in the area, km per class. */
  trailKm: [number, number, number];
  hardKm: number;
  /** Lowest and highest terrain in the area (m). */
  alt: [number, number];
}

/** Where an area lies, from the partition. */
export interface RegionShape {
  range: string;
  names: string[];
  rings: ArcRings;
  label: [number, number];
  bbox: BBox;
  km2: number;
}

/**
 * The index entry of one area. Its default route is the configured one, else its first curated
 * hike, else the longest route it is home to; it throws when that route is not on its list.
 */
export function summariseRegion(cfg: RegionConfig, routes: CatalogueEntry[], facts: RegionFacts, shape: RegionShape): RegionSummary {
  const listed = routes.filter((r) => r.regions.includes(cfg.id));
  const longest = listed.filter((r) => r.regions[0] === cfg.id).sort((a, b) => b.stats.km - a.stats.km || a.id.localeCompare(b.id))[0];
  const defaultRoute = cfg.defaultRoute ?? listed.find((r) => r.source === 'curated')?.id ?? longest?.id;
  if (!listed.some((r) => r.id === defaultRoute)) throw new Error(`${cfg.id}: default route ${defaultRoute ?? '(none)'} is not on its list`);
  const { id, title, subtitle, cantons } = cfg;
  return {
    id, title, subtitle, cantons, range: shape.range, names: shape.names, aliases: cfg.aliases ?? [],
    rings: shape.rings, label: shape.label, bbox: shape.bbox, km2: Math.round(shape.km2),
    defaultRoute: defaultRoute!, routes: listed.length,
    classics: listed.filter((r) => r.source === 'curated').length,
    trailKm: facts.trailKm.map((km) => Math.round(km)) as [number, number, number],
    hardKm: Math.round(facts.hardKm),
    alt: [Math.round(facts.alt[0]), Math.round(facts.alt[1])],
  };
}

/** The index: ranges in the order given, areas sorted by title. */
export function regionIndex(ranges: RangeSummary[], regions: RegionSummary[], arcs: number[][]): RegionIndex {
  return { version: 4, ranges, regions: [...regions].sort((a, b) => a.title.localeCompare(b.title, 'de')), arcs };
}

/** Index file contents: one range, area or arc per line, so a change to one is a one-line diff. */
export function formatIndex(index: RegionIndex): string {
  const list = (items: unknown[]) => `[\n${items.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`;
  return `{\n  "version": ${index.version},\n  "ranges": ${list(index.ranges)},\n  "regions": ${list(index.regions)},\n  "arcs": ${list(index.arcs)}\n}\n`;
}
