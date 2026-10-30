/**
 * v3/regions.json, the regions the app offers: curated entry points into the atlas, each with the
 * facts the region browser shows. build-atlas writes it and check-atlas checks it.
 */
import type { CatalogueEntry, RegionConfig, RegionIndex, RegionSummary } from '../../src/data/types';

/** What a region's box holds, measured by build-atlas. */
export interface RegionFacts {
  /** Signposted network clipped to the box, km per class. */
  trailKm: [number, number, number];
  hardKm: number;
  /** Lowest and highest terrain in the box (m). */
  alt: [number, number];
}

/** The index entry of one region; throws when its default route is not on its list. */
export function summariseRegion(cfg: RegionConfig, routes: CatalogueEntry[], facts: RegionFacts): RegionSummary {
  const listed = routes.filter((r) => r.regions.includes(cfg.id));
  const defaultRoute = cfg.defaultRoute ?? listed.find((r) => r.source === 'curated')?.id ?? listed[0]?.id;
  if (!listed.some((r) => r.id === defaultRoute)) throw new Error(`${cfg.id}: default route ${defaultRoute ?? '(none)'} is not on its list`);
  const { id, title, subtitle, cantons, bbox } = cfg;
  return {
    id, title, subtitle, cantons, bbox, defaultRoute: defaultRoute!, routes: listed.length,
    classics: listed.filter((r) => r.source === 'curated').length,
    trailKm: facts.trailKm.map((km) => Math.round(km)) as [number, number, number],
    hardKm: Math.round(facts.hardKm),
    alt: [Math.round(facts.alt[0]), Math.round(facts.alt[1])],
  };
}

/** The index, sorted by title. */
export function regionIndex(regions: RegionSummary[]): RegionIndex {
  return { version: 3, regions: [...regions].sort((a, b) => a.title.localeCompare(b.title, 'de')) };
}

/** Index file contents: one region per line, so a new region is a one-line diff. */
export function formatIndex(index: RegionIndex): string {
  return `{\n  "version": ${index.version},\n  "regions": [\n${index.regions.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`;
}
