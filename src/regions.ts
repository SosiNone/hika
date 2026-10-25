import type { RegionSummary } from './data/types';

/** Region opened when the URL names none: the first region HIKA had, so older `#route=` links keep working. */
export const DEFAULT_REGION = 'alpstein';

/** The region `?region=<id>` asks for, else DEFAULT_REGION, else the first one; undefined when none is built. */
export function pickRegion(regions: RegionSummary[], search: string): RegionSummary | undefined {
  const id = new URLSearchParams(search).get('region');
  return regions.find((r) => r.id === id) ?? regions.find((r) => r.id === DEFAULT_REGION) ?? regions[0];
}

/**
 * The URL of another region: `?region=<id>` with the other query parameters (`?scheme=`) kept and
 * the hash dropped, since route ids belong to a region.
 */
export function regionHref(id: string, href: string): string {
  const url = new URL(href);
  url.searchParams.set('region', id);
  url.hash = '';
  return url.href;
}
