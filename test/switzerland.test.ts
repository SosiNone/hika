import { describe, expect, it } from 'vitest';
import type { RegionSummary } from '../src/data/types';
import { hitRegion, placeLabels, type Rect, type Target } from '../src/hud/switzerland';

const target = (id: string, rect: Rect): Target => ({
  region: { id } as RegionSummary, rect, cx: (rect[0] + rect[2]) / 2, cy: (rect[1] + rect[3]) / 2,
});

describe('hitRegion', () => {
  // Two neighbouring boxes whose padded rectangles overlap at the shared edge.
  const targets = [target('west', [0, 0, 20, 10]), target('east', [20, 0, 40, 10])];

  it('takes the box whose centre is nearest', () => {
    expect(hitRegion(targets, 21, 5, 6)?.id).toBe('east');
    expect(hitRegion(targets, 19, 5, 6)?.id).toBe('west');
  });

  it('counts the padding, and nothing beyond it', () => {
    expect(hitRegion(targets, -5, 5, 6)?.id).toBe('west');
    expect(hitRegion(targets, -7, 5, 6)).toBeNull();
  });
});

describe('placeLabels', () => {
  const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

  it('places labels inside the view without overlaps', () => {
    const items = Array.from({ length: 12 }, (_, k) => ({ id: `r${k}`, box: [20 + (k % 4) * 50, 20 + Math.floor(k / 4) * 40, 50 + (k % 4) * 50, 40 + Math.floor(k / 4) * 40] as Rect, w: 40, h: 12 }));
    const placed = [...placeLabels(items, 240, 160).values()];
    expect(placed.length).toBeGreaterThan(0);
    for (const r of placed) expect(r[0] >= 0 && r[1] >= 0 && r[2] <= 240 && r[3] <= 160).toBe(true);
    placed.forEach((a, i) => placed.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
  });

  it('prefers the right of the box, and leaves out what does not fit', () => {
    const placed = placeLabels([{ id: 'a', box: [10, 10, 30, 30], w: 40, h: 10 }, { id: 'b', box: [10, 10, 30, 30], w: 200, h: 10 }], 100, 40);
    expect(placed.get('a')).toEqual([33, 15, 73, 25]);
    expect(placed.has('b')).toBe(false);
  });

  it('always places a forced label, inside the view', () => {
    const placed = placeLabels([{ id: 'a', box: [80, 0, 100, 40], w: 60, h: 40, force: true }], 100, 40);
    const r = placed.get('a')!;
    expect(r[0]).toBeGreaterThanOrEqual(0);
    expect(r[2]).toBeLessThanOrEqual(100);
  });
});
