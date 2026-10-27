import type { RegionSummary } from './data/types';

/** Region opened when the URL names none: the first region HIKA had, so older `#route=` links keep working. */
export const DEFAULT_REGION = 'alpstein';

/** The region `?region=<id>` asks for, else DEFAULT_REGION, else the first one; undefined when none is built. */
export function pickRegion(regions: RegionSummary[], search: string): RegionSummary | undefined {
  const id = new URLSearchParams(search).get('region');
  return regions.find((r) => r.id === id) ?? regions.find((r) => r.id === DEFAULT_REGION) ?? regions[0];
}

/** Canton names by code, in their official languages and English, for the region filter. */
export const CANTON_NAMES: Record<string, string> = {
  AG: 'Aargau Argovie', AI: 'Appenzell Innerrhoden', AR: 'Appenzell Ausserrhoden', BE: 'Bern Berne',
  BL: 'Basel-Landschaft Bâle-Campagne', BS: 'Basel-Stadt Bâle-Ville', FR: 'Fribourg Freiburg', GE: 'Genève Genf Geneva',
  GL: 'Glarus Glaris', GR: 'Graubünden Grisons Grigioni Grischun', JU: 'Jura', LU: 'Luzern Lucerne',
  NE: 'Neuchâtel Neuenburg', NW: 'Nidwalden Nidwald', OW: 'Obwalden Obwald', SG: 'St. Gallen Saint-Gall',
  SH: 'Schaffhausen Schaffhouse', SO: 'Solothurn Soleure', SZ: 'Schwyz', TG: 'Thurgau Thurgovie', TI: 'Ticino Tessin',
  UR: 'Uri', VD: 'Vaud Waadt', VS: 'Valais Wallis', ZG: 'Zug Zoug', ZH: 'Zürich Zurich',
};

/**
 * The regions whose title, subtitle or cantons (code or name) contain every word of `query`,
 * ignoring case and accents ("neuchatel" finds the region in Neuchâtel), in their original order.
 */
export function filterRegions<R extends Pick<RegionSummary, 'title' | 'subtitle' | 'cantons'>>(regions: R[], query: string): R[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return regions;
  return regions.filter((r) => {
    const text = fold(`${r.title} ${r.subtitle} ${r.cantons.map((c) => `${c} ${CANTON_NAMES[c] ?? ''}`).join(' ')}`);
    return words.every((w) => text.includes(w));
  });
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

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
