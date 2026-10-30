import { routeWindow } from './data/tiles';
import type { BBox, CatalogueEntry, RegionSummary } from './data/types';

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

const intersects = (a: BBox, b: BBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * The page for a route no region lists: its window, as a region with no id, listing every route
 * that crosses it. Its network and altitude facts come from the window once it is loaded.
 */
export function nearbyRegion(route: CatalogueEntry, routes: CatalogueEntry[]): RegionSummary {
  const bbox = routeWindow(route.bbox), near = routes.filter((r) => intersects(r.bbox, bbox));
  return {
    id: '', title: `Around ${route.from}`, subtitle: `${route.name} and the routes near it`, cantons: [], bbox, defaultRoute: route.id,
    routes: near.length, classics: near.filter((r) => r.source === 'curated').length, trailKm: [0, 0, 0], hardKm: 0, alt: [0, 0],
  };
}

/** The routes a page lists: those a region names, or for a route's neighbourhood (`nearbyRegion`) those that cross it. */
export function routesOf<R extends Pick<CatalogueEntry, 'regions' | 'bbox'>>(region: Pick<RegionSummary, 'id' | 'bbox'>, routes: R[]): R[] {
  return routes.filter((r) => (region.id ? r.regions.includes(region.id) : intersects(r.bbox, region.bbox)));
}

/** The URL that opens a route: in the first region that lists it, else in its own neighbourhood. */
export function routeHref(route: Pick<CatalogueEntry, 'id' | 'regions'>, href: string): string {
  const url = new URL(href);
  if (route.regions[0]) url.searchParams.set('region', route.regions[0]);
  else url.searchParams.delete('region');
  url.hash = `route=${route.id}`;
  return url.href;
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
