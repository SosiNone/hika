import { describe, expect, it } from 'vitest';
import type { CatalogueEntry, RangeSummary, RegionConfig, RegionSummary } from '../src/data/types';
import { DEFAULT_REGION, filterRegions, filterRoutes, pickRegion, rangeOf, regionHref, routeHref, routesOf } from '../src/regions';
import { formatIndex, regionIndex, summariseRegion } from '../scripts/lib/regions';

const summary = (id: string, aliases: string[] = []): RegionSummary => ({
  id, title: id, subtitle: '', cantons: [], range: 'jura', names: [], aliases, rings: [[0, 1, 2]], label: [0, 0], bbox: [0, 0, 1, 1], km2: 1,
  defaultRoute: 'c-x', routes: 1, classics: 1, trailKm: [1, 0, 0], hardKm: 0, alt: [400, 900],
});
const range = (id: string, title: string, names: string[]): RangeSummary => ({ id, title, names, rings: [[0]], label: [0, 0], bbox: [0, 0, 1, 1], areas: [], routes: 0 });

describe('pickRegion', () => {
  const regions = [summary('jungfrau'), summary(DEFAULT_REGION)];

  it('takes ?region= when it is built', () => expect(pickRegion(regions, '?region=jungfrau')?.id).toBe('jungfrau'));
  it('takes a former id', () => expect(pickRegion([summary('haslital', ['hasliberg']), summary(DEFAULT_REGION)], '?region=hasliberg')?.id).toBe('haslital'));
  it('falls back to the default area without one', () => expect(pickRegion(regions, '?scheme=light')?.id).toBe(DEFAULT_REGION));
  it('falls back to the default area for an unknown one', () => expect(pickRegion(regions, '?region=nowhere')?.id).toBe(DEFAULT_REGION));
  it('falls back to the first area without the default', () => expect(pickRegion([summary('jungfrau')], '')?.id).toBe('jungfrau'));
  it('returns undefined when nothing is built', () => expect(pickRegion([], '')).toBeUndefined());
});

describe('regionHref', () => {
  it('keeps other parameters and drops the route', () => {
    expect(regionHref('jungfrau', 'https://example.org/hika/?scheme=light#route=sm-951.00')).toBe('https://example.org/hika/?scheme=light&region=jungfrau');
  });
  it('replaces the current area', () => {
    expect(regionHref('alpstein', 'http://localhost:5173/?region=jungfrau#route=sm-353.00&reverse=1')).toBe('http://localhost:5173/?region=alpstein');
  });
});

describe('filterRegions', () => {
  const regions = [
    { ...summary('jura'), title: 'Jura', subtitle: 'Creux du Van · Chasseron', cantons: ['NE', 'VD'] },
    { ...summary('engadin'), title: 'Engadin', subtitle: 'St. Moritz · Pontresina', cantons: ['GR'], range: 'raetische-alpen', names: ["Engiadin'Ota", 'Oberengadin'] },
    { ...summary('verbier', ['bagnes']), title: 'Verbier', subtitle: 'Val de Bagnes · Nendaz', cantons: ['VS'], range: 'walliser-alpen' },
  ];
  const ranges = [range('raetische-alpen', 'Rhaetian Alps', ['Rätische Alpen', 'Alpi Retiche']), range('walliser-alpen', 'Valais Alps', ['Walliser Alpen'])];
  const ids = (q: string) => filterRegions(regions, q, ranges).map((r) => r.id);

  it('keeps every area for an empty query', () => expect(ids('  ')).toEqual(['jura', 'engadin', 'verbier']));
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
  it('matches official names in any language, and former ids', () => {
    expect(ids('oberengadin')).toEqual(['engadin']);
    expect(ids('bagnes')).toEqual(['verbier']);
  });
  it('matches the range by its title and official names', () => {
    expect(ids('rhaetian')).toEqual(['engadin']);
    expect(ids('walliser alpen')).toEqual(['verbier']);
  });
});

describe('rangeOf', () => {
  it('finds the range of an area', () => expect(rangeOf([range('jura', 'Jura', ['Jura'])], summary('ajoie'))?.title).toBe('Jura'));
});

describe('summariseRegion', () => {
  const route = (id: string, source: 'schweizmobil' | 'curated', regions: string[], km = 5) => ({ id, source, regions, stats: { km } }) as CatalogueEntry;
  // The catalogue holds every route; the area lists those that name it.
  const routes = [route('sm-1.01', 'schweizmobil', ['r']), route('c-a', 'curated', ['r']), route('sm-2.01', 'schweizmobil', ['other'])];
  const cfg = (defaultRoute?: string, aliases?: string[]) => ({ id: 'r', title: 'R', subtitle: 'S', cantons: ['BE'], defaultRoute, aliases }) as RegionConfig;
  const facts = { trailKm: [512.4, 300.6, 9.49] as [number, number, number], hardKm: 40.6, alt: [567.4, 3970.6] as [number, number] };
  const shape = { range: 'jura', names: ['Ajoie'], rings: [[0, -2]], label: [2_570_000, 1_250_000] as [number, number], bbox: [2_560_000, 1_240_000, 2_580_000, 1_260_000] as [number, number, number, number], km2: 412.6 };

  it('uses the configured default route', () => expect(summariseRegion(cfg('sm-1.01'), routes, facts, shape).defaultRoute).toBe('sm-1.01'));
  it('defaults to the first curated hike', () => expect(summariseRegion(cfg(), routes, facts, shape).defaultRoute).toBe('c-a'));
  it('defaults to its longest home route without one', () => {
    const plain = [route('sm-1.01', 'schweizmobil', ['r']), route('sm-3.01', 'schweizmobil', ['r'], 12), route('sm-4.01', 'schweizmobil', ['other', 'r'], 30)];
    expect(summariseRegion(cfg(), plain, facts, shape).defaultRoute).toBe('sm-3.01');
  });
  it('rejects a default route the area does not list', () => expect(() => summariseRegion(cfg('sm-2.01'), routes, facts, shape)).toThrow(/sm-2.01/));
  it('counts the routes it lists', () => expect(summariseRegion(cfg(), routes, facts, shape).routes).toBe(2));
  it('sums up the area and keeps its shape', () => {
    const { classics, trailKm, hardKm, alt, range: r, rings, km2, aliases } = summariseRegion(cfg(undefined, ['old']), routes, facts, shape);
    expect({ classics, trailKm, hardKm, alt, r, rings, km2, aliases }).toEqual({ classics: 1, trailKm: [512, 301, 9], hardKm: 41, alt: [567, 3971], r: 'jura', rings: [[0, -2]], km2: 413, aliases: ['old'] });
  });
});

describe('formatIndex', () => {
  it('writes valid JSON with one range, area or arc per line, areas sorted by title', () => {
    const ranges = [range('jura', 'Jura', ['Jura'])], arcs = [[260_000, 120_000, 20, 0], [260_020, 120_000, 0, 20]];
    const text = formatIndex(regionIndex(ranges, [summary('b'), summary('a')], arcs));
    expect(JSON.parse(text)).toEqual({ version: 4, ranges, regions: [summary('a'), summary('b')], arcs });
    expect(text.split('\n').filter((l) => l.includes('"id"'))).toHaveLength(3);
    expect(text.split('\n').filter((l) => l.trim().startsWith('[2600'))).toHaveLength(2);
  });
});

const entry = (id: string, name: string, from: string, to: string, bbox: [number, number, number, number], regions: string[] = []) =>
  ({ id, number: id.startsWith('sm-') ? id.slice(3).replace(/\.00$/, '') : null, name, from, to, source: id.startsWith('sm-') ? 'schweizmobil' : 'curated', bbox, regions }) as unknown as CatalogueEntry;
const catalogue = [
  entry('sm-1.01', 'Via Alpina', 'Vaduz (Gaflei, FL)', 'Sargans', [2755000, 1210000, 2760000, 1225000], ['alpstein']),
  entry('sm-893.00', 'Albisgrat-Höhenweg', 'Uetliberg', 'Albis Hochwacht', [2678000, 1236000, 2682000, 1245000]),
  entry('sm-951.00', 'Gamplüt-Säntis-Weg', 'Wildhaus, Gamplüt', 'Säntis', [2741000, 1229000, 2745000, 1235000], ['alpstein', 'toggenburg']),
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

describe('routesOf', () => {
  it('lists the routes that name the area', () => {
    expect(routesOf({ id: 'alpstein' }, catalogue).map((r) => r.id)).toEqual(['sm-1.01', 'sm-951.00']);
    expect(routesOf({ id: 'toggenburg' }, catalogue).map((r) => r.id)).toEqual(['sm-951.00']);
  });
});

describe('routeHref', () => {
  it('opens a route in its home area', () => expect(routeHref(catalogue[2], 'https://x.ch/hika/?scheme=light#route=c-a')).toBe('https://x.ch/hika/?scheme=light&region=alpstein#route=sm-951.00'));
  it('drops the area for a route that has none', () => expect(routeHref(catalogue[1], 'https://x.ch/hika/?region=alpstein')).toBe('https://x.ch/hika/#route=sm-893.00'));
});
