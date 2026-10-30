import { describe, expect, it } from 'vitest';
import type { CatalogueEntry, RegionConfig, RegionSummary } from '../src/data/types';
import { windowFacts, type TerrainWindow } from '../src/data/load';
import { DEFAULT_REGION, filterRegions, filterRoutes, nearbyRegion, pickRegion, regionHref, routeHref, routesOf } from '../src/regions';
import { formatIndex, regionIndex, summariseRegion } from '../scripts/lib/regions';

const summary = (id: string): RegionSummary => ({ id, title: id, subtitle: '', cantons: [], bbox: [0, 0, 1, 1], defaultRoute: 'c-x', routes: 1, classics: 1, trailKm: [1, 0, 0], hardKm: 0, alt: [400, 900] });

describe('pickRegion', () => {
  const regions = [summary('jungfrau'), summary(DEFAULT_REGION)];

  it('takes ?region= when it is built', () => expect(pickRegion(regions, '?region=jungfrau')?.id).toBe('jungfrau'));
  it('falls back to the default region without one', () => expect(pickRegion(regions, '?scheme=light')?.id).toBe(DEFAULT_REGION));
  it('falls back to the default region for an unknown one', () => expect(pickRegion(regions, '?region=nowhere')?.id).toBe(DEFAULT_REGION));
  it('falls back to the first region without the default', () => expect(pickRegion([summary('jungfrau')], '')?.id).toBe('jungfrau'));
  it('returns undefined when nothing is built', () => expect(pickRegion([], '')).toBeUndefined());
});

describe('regionHref', () => {
  it('keeps other parameters and drops the route', () => {
    expect(regionHref('jungfrau', 'https://example.org/hika/?scheme=light#route=sm-951.00')).toBe('https://example.org/hika/?scheme=light&region=jungfrau');
  });
  it('replaces the current region', () => {
    expect(regionHref('alpstein', 'http://localhost:5173/?region=jungfrau#route=sm-353.00&reverse=1')).toBe('http://localhost:5173/?region=alpstein');
  });
});

describe('filterRegions', () => {
  const regions = [
    { ...summary('jura'), title: 'Jura', subtitle: 'Creux du Van · Chasseron', cantons: ['NE', 'VD'] },
    { ...summary('engadin'), title: 'Engadin', subtitle: 'St. Moritz · Pontresina', cantons: ['GR'] },
    { ...summary('verbier'), title: 'Verbier', subtitle: 'Val de Bagnes · Nendaz', cantons: ['VS'] },
  ];
  const ids = (q: string) => filterRegions(regions, q).map((r) => r.id);

  it('keeps every region for an empty query', () => expect(ids('  ')).toEqual(['jura', 'engadin', 'verbier']));
  it('matches titles and subtitles, ignoring case', () => expect(ids('moritz')).toEqual(['engadin']));
  it('ignores accents both ways', () => {
    expect(ids('neuchatel')).toEqual(['jura']);
    expect(ids('Grisöns')).toEqual(['engadin']);
  });
  it('matches canton codes and names', () => {
    expect(ids('vs')).toEqual(['verbier']);
    expect(ids('wallis')).toEqual(['verbier']);
  });
  it('needs every word', () => expect(ids('val nendaz')).toEqual(['verbier']));
});

describe('summariseRegion', () => {
  const route = (id: string, source: 'schweizmobil' | 'curated', regions: string[]) => ({ id, source, regions }) as CatalogueEntry;
  // The catalogue holds every route; the region lists those that name it.
  const routes = [route('sm-1.01', 'schweizmobil', ['r']), route('c-a', 'curated', ['r']), route('sm-2.01', 'schweizmobil', ['other'])];
  const cfg = (defaultRoute?: string) => ({ id: 'r', title: 'R', subtitle: 'S', cantons: ['BE'], bbox: [0, 0, 1000, 1000], defaultRoute }) as RegionConfig;
  const facts = { trailKm: [512.4, 300.6, 9.49] as [number, number, number], hardKm: 40.6, alt: [567.4, 3970.6] as [number, number] };

  it('uses the configured default route', () => expect(summariseRegion(cfg('sm-1.01'), routes, facts).defaultRoute).toBe('sm-1.01'));
  it('defaults to the first curated hike', () => expect(summariseRegion(cfg(), routes, facts).defaultRoute).toBe('c-a'));
  it('rejects a default route the region does not list', () => expect(() => summariseRegion(cfg('sm-2.01'), routes, facts)).toThrow(/sm-2.01/));
  it('counts the routes it lists', () => expect(summariseRegion(cfg(), routes, facts).routes).toBe(2));
  it('sums up the region', () => {
    const { classics, trailKm, hardKm, alt } = summariseRegion(cfg(), routes, facts);
    expect({ classics, trailKm, hardKm, alt }).toEqual({ classics: 1, trailKm: [512, 301, 9], hardKm: 41, alt: [567, 3971] });
  });
});

describe('formatIndex', () => {
  it('writes valid JSON with one region per line', () => {
    const text = formatIndex(regionIndex([summary('b'), summary('a')]));
    expect(JSON.parse(text)).toEqual({ version: 3, regions: [summary('a'), summary('b')] });
    expect(text.split('\n').filter((l) => l.includes('"id"'))).toHaveLength(2);
  });
});

const entry = (id: string, name: string, from: string, to: string, bbox: [number, number, number, number], regions: string[] = []) =>
  ({ id, number: id.startsWith('sm-') ? id.slice(3).replace(/\.00$/, '') : null, name, from, to, source: id.startsWith('sm-') ? 'schweizmobil' : 'curated', bbox, regions }) as unknown as CatalogueEntry;
const catalogue = [
  entry('sm-1.01', 'Via Alpina', 'Vaduz (Gaflei, FL)', 'Sargans', [2755000, 1210000, 2760000, 1225000], ['alpstein']),
  entry('sm-893.00', 'Albisgrat-Höhenweg', 'Uetliberg', 'Albis Hochwacht', [2678000, 1236000, 2682000, 1245000]),
  entry('sm-951.00', 'Gamplüt-Säntis-Weg', 'Wildhaus, Gamplüt', 'Säntis', [2741000, 1229000, 2745000, 1235000], ['alpstein']),
  entry('sm-890.00', 'Uetliberg-Felsenegg', 'Uetliberg', 'Felsenegg', [2679000, 1240000, 2681000, 1243000]),
];

describe('filterRoutes', () => {
  const ids = (q: string) => filterRoutes(catalogue, q).map((r) => r.id);
  it('finds routes by name, number, start or end, ignoring accents', () => {
    expect(ids('hohenweg')).toEqual(['sm-893.00']);
    expect(ids('951')).toEqual(['sm-951.00']);
    expect(ids('sargans')).toEqual(['sm-1.01']);
  });
  it('needs every word', () => expect(ids('uetliberg felsenegg')).toEqual(['sm-890.00']));
  it('puts names and numbers that start with the query first', () => expect(ids('uetliberg')).toEqual(['sm-890.00', 'sm-893.00']));
  it('finds nothing without a query', () => expect(ids('  ')).toEqual([]));
});

describe('nearbyRegion', () => {
  const near = nearbyRegion(catalogue[1], catalogue);
  it('is the route\'s own window, with no id', () => {
    expect(near.id).toBe('');
    expect(near.bbox).toEqual([2676000, 1234000, 2684000, 1247000]);
    expect(near.defaultRoute).toBe('sm-893.00');
    expect(near.title).toBe('Around Uetliberg');
  });
  it('lists the routes that cross it', () => {
    expect(routesOf(near, catalogue).map((r) => r.id)).toEqual(['sm-893.00', 'sm-890.00']);
    expect(near.routes).toBe(2);
  });
  it('leaves a region its own list', () => expect(routesOf({ id: 'alpstein', bbox: [0, 0, 1, 1] }, catalogue).map((r) => r.id)).toEqual(['sm-1.01', 'sm-951.00']));
});

describe('routeHref', () => {
  it('opens a route in the first region that lists it', () => expect(routeHref(catalogue[2], 'https://x.ch/hika/?scheme=light#route=c-a')).toBe('https://x.ch/hika/?scheme=light&region=alpstein#route=sm-951.00'));
  it('opens one no region lists on its own', () => expect(routeHref(catalogue[1], 'https://x.ch/hika/?region=alpstein')).toBe('https://x.ch/hika/#route=sm-893.00'));
});

describe('windowFacts', () => {
  it('measures the network by class and the altitude range of a window', () => {
    // A 1 km Wanderweg on asphalt and a 500 m Bergwanderweg.
    const win = {
      grid: { minAlt: 410, maxAlt: 1810 },
      trails: { offsets: Uint32Array.of(0, 2, 4), cls: Uint8Array.of(0, 1), hard: Uint8Array.of(1, 0), xy: Uint16Array.of(0, 0, 1000, 0, 0, 0, 300, 400) },
    } as unknown as TerrainWindow;
    expect(windowFacts(win)).toEqual({ trailKm: [1, 1, 0], hardKm: 1, alt: [410, 1810] });
  });
});
