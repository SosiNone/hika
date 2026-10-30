import { describe, expect, it } from 'vitest';
import { decodeGrid, decodeRoute, decodeTrails, encodeGrid, encodeRoute, encodeTrails, type Trails } from '../src/data/codec';
import type { AtlasRoute } from '../src/data/types';

const buffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('terrain grid', () => {
  it('round-trips heights, no-data cells and summits above 3276.7 m', () => {
    // 4 × 3 decimetres: a border corner (0), the Dufourspitze (46340 dm) next to a cliff.
    const h = Uint16Array.of(0, 0, 21000, 21500, 0, 20800, 46340, 22000, 19000, 19500, 30000, 65535);
    expect(decodeGrid(encodeGrid(h, 4), 4, 3)).toEqual(h);
  });
  it('turns a smooth slope into small residuals', () => {
    const cols = 50, h = Uint16Array.from({ length: cols * 40 }, (_, i) => 15000 + (i % cols) * 3 + Math.floor(i / cols) * 7);
    const bytes = encodeGrid(h, cols);
    // The high-byte plane is all zero apart from the first cells, which the predictor cannot see past.
    expect(bytes.subarray(h.length + cols + 1).every((b) => b === 0)).toBe(true);
    expect(decodeGrid(bytes, cols, 40)).toEqual(h);
  });
  it('rejects a file of the wrong size', () => expect(() => decodeGrid(new Uint8Array(10), 4, 3)).toThrow(/4 × 3/));
});

describe('trails', () => {
  const trails: Trails = {
    offsets: Uint32Array.of(0, 3, 4, 6),
    cls: Uint8Array.of(0, 1, 2),
    hard: Uint8Array.of(1, 0, 0),
    // Three lines, one of a single vertex; coordinates at both ends of the Uint16 range.
    xy: Uint16Array.of(10, 20, 15, 18, 0, 65535, 40000, 3, 65535, 0, 1, 1),
  };

  it('round-trips lines, classes and surfaces', () => {
    const back = decodeTrails(buffer(encodeTrails(trails)));
    expect(back.offsets).toEqual(trails.offsets);
    expect(back.cls).toEqual(trails.cls);
    expect(back.hard).toEqual(trails.hard);
    expect(back.xy).toEqual(trails.xy);
  });
  it('refuses the old format', () => {
    const old = encodeTrails(trails);
    old.set([72, 75, 84, 82]); // 'HKTR', the format before HKT2
    expect(() => decodeTrails(buffer(old))).toThrow(/HKT2/);
  });
});

describe('atlas route', () => {
  const route: AtlasRoute = {
    id: 'sm-951.00', number: '951', name: 'Test', from: 'A', to: 'B', source: 'schweizmobil', category: 'local', step: 10,
    // Absolute LV95 to 0.1 m, stepping back and forth; altitudes above 3276.7 m and a descent.
    e: [2736000.1, 2736009.9, 2736001.4, 2735991.5],
    n: [1227000, 1227005.3, 1227012.8, 1227004.2],
    alt: [4633.9, 4630.2, 4634.5, 1795.0],
    cls: [0, 1, 255, 2],
    surf: [1, 0, 0, 1],
    stats: { km: 0.03, up: 4, down: 2839, time: 30, timeBack: 90, minAlt: 1795, maxAlt: 4635, classKm: [0.01, 0.01, 0, 0.01], hardKm: 0.01, steepKm: 0 },
    waypoints: [{ place: 'p1', km: 0, alt: 4634, time: 0 }, { place: 'p2', km: 0.03, alt: 1795, time: 30 }],
    places: [{ id: 'p1', name: 'Dufourspitze', kind: 'summit', e: 2736000, n: 1227000, alt: 4634, prio: 100 }],
  };

  it('round-trips samples, meta, waypoints and places', () => {
    const back = decodeRoute(buffer(encodeRoute(route)));
    expect(back).toEqual(route);
  });
  it('refuses samples too far apart for a 16-bit delta', () => {
    expect(() => encodeRoute({ ...route, e: [2736000, 2740000, 2740001, 2740002] })).toThrow(/too far apart/);
  });
});
