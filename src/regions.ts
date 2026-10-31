import type { CatalogueEntry, RangeSummary, RegionSummary } from './data/types';

/** Area opened when the URL names none: the first region HIKA had, so older `#route=` links keep working. */
export const DEFAULT_REGION = 'alpstein';

/**
 * The area `?region=<id>` asks for, by its id or a former one (`aliases`), else DEFAULT_REGION,
 * else the first one; undefined when none is built.
 */
export function pickRegion(regions: RegionSummary[], search: string): RegionSummary | undefined {
  const id = new URLSearchParams(search).get('region');
  return regions.find((r) => r.id === id) ?? regions.find((r) => id !== null && r.aliases.includes(id)) ?? regions.find((r) => r.id === DEFAULT_REGION) ?? regions[0];
}

/** The range an area belongs to. */
export function rangeOf(ranges: RangeSummary[], region: Pick<RegionSummary, 'range'>): RangeSummary | undefined {
  return ranges.find((g) => g.id === region.range);
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

type Searchable = Pick<RegionSummary, 'title' | 'subtitle' | 'cantons' | 'names' | 'aliases' | 'range'>;

/**
 * The areas whose title, subtitle, official names (in every language: "conches" finds Goms),
 * former ids, cantons (code or name) or range contain every word of `query`, ignoring case and
 * accents ("neuchatel" finds the areas in Neuchâtel), in their original order.
 */
export function filterRegions<R extends Searchable>(regions: R[], query: string, ranges: Pick<RangeSummary, 'id' | 'title' | 'names'>[] = []): R[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return regions;
  return regions.filter((r) => {
    const range = ranges.find((g) => g.id === r.range);
    const text = fold([
      r.title, r.subtitle, ...r.names, ...r.aliases, ...r.cantons.map((c) => `${c} ${CANTON_NAMES[c] ?? ''}`),
      ...(range ? [range.title, ...range.names] : []),
    ].join(' '));
    return words.every((w) => text.includes(w));
  });
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * The routes whose number, name, start or end contain every word of `query` (case and accents
 * ignored): those whose number or name starts with it first, then the rest, each in catalogue order.
 */
export function filterRoutes<R extends Pick<CatalogueEntry, 'number' | 'name' | 'from' | 'to'>>(routes: R[], query: string): R[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const found = routes.filter((r) => {
    const text = fold(`${r.number ?? ''} ${r.name} ${r.from} ${r.to}`);
    return words.every((w) => text.includes(w));
  });
  const q = words.join(' ');
  const first = (r: R) => (fold(r.number ?? '').startsWith(q) || fold(r.name).startsWith(q) ? 0 : 1);
  return found.map((r, i) => ({ r, i })).sort((a, b) => first(a.r) - first(b.r) || a.i - b.i).map(({ r }) => r);
}

/** The routes an area lists: its home routes and those it holds enough of. */
export function routesOf<R extends Pick<CatalogueEntry, 'regions'>>(region: Pick<RegionSummary, 'id'>, routes: R[]): R[] {
  return routes.filter((r) => r.regions.includes(region.id));
}

/** The URL that opens a route: in its home area, the one holding most of it. */
export function routeHref(route: Pick<CatalogueEntry, 'id' | 'regions'>, href: string): string {
  const url = new URL(href);
  if (route.regions[0]) url.searchParams.set('region', route.regions[0]);
  else url.searchParams.delete('region');
  url.hash = `route=${route.id}`;
  return url.href;
}

/**
 * The URL of another area: `?region=<id>` with the other query parameters (`?scheme=`) kept and
 * the hash dropped, since route ids belong to an area.
 */
export function regionHref(id: string, href: string): string {
  const url = new URL(href);
  url.searchParams.set('region', id);
  url.hash = '';
  return url.href;
}
