import { describe, expect, it } from 'vitest';
import type { CatalogueEntry, RegionConfig, RegionSummary } from '../src/data/types';
import { DEFAULT_REGION, filterRegions, pickRegion, regionHref } from '../src/regions';
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
