import { describe, expect, it } from 'vitest';
import type { RegionBundle, RegionSummary } from '../src/data/types';
import { DEFAULT_REGION, pickRegion, regionHref } from '../src/regions';
import { formatIndex, summariseRegion } from '../scripts/lib/regions';

const summary = (id: string): RegionSummary => ({ id, title: id, subtitle: '', cantons: [], bbox: [0, 0, 1, 1], defaultRoute: 'c-x', routes: 1 });

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

describe('summariseRegion', () => {
  const route = (id: string, source: 'schweizmobil' | 'curated') => ({ id, source }) as RegionBundle['routes'][number];
  const bundle = { id: 'r', title: 'R', subtitle: 'S', cantons: ['BE'], bbox: [0, 0, 1000, 1000], routes: [route('sm-1.01', 'schweizmobil'), route('c-a', 'curated')] } as unknown as RegionBundle;

  it('uses the configured default route', () => expect(summariseRegion(bundle, { defaultRoute: 'sm-1.01' }).defaultRoute).toBe('sm-1.01'));
  it('defaults to the first curated hike', () => expect(summariseRegion(bundle, {}).defaultRoute).toBe('c-a'));
  it('rejects a default route the bundle lacks', () => expect(() => summariseRegion(bundle, { defaultRoute: 'c-gone' })).toThrow(/c-gone/));
  it('counts routes', () => expect(summariseRegion(bundle, {}).routes).toBe(2));
});

describe('formatIndex', () => {
  it('writes valid JSON with one region per line', () => {
    const text = formatIndex({ version: 1, regions: [summary('a'), summary('b')] });
    expect(JSON.parse(text)).toEqual({ version: 1, regions: [summary('a'), summary('b')] });
    expect(text.split('\n').filter((l) => l.includes('"id"'))).toHaveLength(2);
  });
});
