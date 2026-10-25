/**
 * public/data/regions.json, the list of regions the app offers. It is derived from the built
 * bundles (plus `defaultRoute` from their configs), so build-region rewrites it after every build
 * and check-region fails when it is out of date.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { RegionBundle, RegionConfig, RegionIndex, RegionSummary } from '../../src/data/types';

export const DATA_DIR = 'public/data';
export const INDEX_FILE = `${DATA_DIR}/regions.json`;

/** The index entry of one region; throws when its default route is not in the bundle. */
export function summariseRegion(bundle: RegionBundle, cfg: Pick<RegionConfig, 'defaultRoute'>): RegionSummary {
  const defaultRoute = cfg.defaultRoute ?? bundle.routes.find((r) => r.source === 'curated')?.id ?? bundle.routes[0]?.id;
  if (!bundle.routes.some((r) => r.id === defaultRoute)) throw new Error(`${bundle.id}: default route ${defaultRoute ?? '(none)'} is not in the bundle`);
  const { id, title, subtitle, cantons, bbox } = bundle;
  return { id, title, subtitle, cantons, bbox, defaultRoute: defaultRoute!, routes: bundle.routes.length };
}

/** Ids of the regions that have a bundle (public/data/<id>/region.json). */
export function builtRegions(): string[] {
  return readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${DATA_DIR}/${d.name}/region.json`))
    .map((d) => d.name)
    .sort();
}

/** The index as the bundles on disk describe it, sorted by title. */
export function buildRegionIndex(): RegionIndex {
  const read = <T>(file: string) => JSON.parse(readFileSync(file, 'utf8')) as T;
  const regions = builtRegions().map((id) => summariseRegion(read<RegionBundle>(`${DATA_DIR}/${id}/region.json`), read<RegionConfig>(`regions/${id}.json`)));
  regions.sort((a, b) => a.title.localeCompare(b.title, 'de'));
  return { version: 1, regions };
}

/** Index file contents: one region per line, so a new region is a one-line diff. */
export function formatIndex(index: RegionIndex): string {
  return `{\n  "version": ${index.version},\n  "regions": [\n${index.regions.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]\n}\n`;
}

export function writeRegionIndex(): RegionIndex {
  const index = buildRegionIndex();
  writeFileSync(INDEX_FILE, formatIndex(index));
  return index;
}
