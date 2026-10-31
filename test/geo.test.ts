import { describe, expect, it } from 'vitest';
import { formatDuration, paceMinPerKm, segmentMinutes, signpostMinutes } from '../src/geo/hikingTime';
import { lv95ToWgs84, wgs84ToLv95 } from '../src/geo/lv95';
import { climb, insideRings, polylineLength, resample, simplify, type XY } from '../src/geo/track';

describe('LV95 <-> WGS84', () => {
  // swisstopo's worked example: 46°02'38.87" N, 8°43'49.79" E  <->  E 2 700 000, N 1 100 000.
  const lat = 46 + 2 / 60 + 38.87 / 3600, lon = 8 + 43 / 60 + 49.79 / 3600;
  it('projects the reference point to within 1 m', () => {
    const [e, n] = wgs84ToLv95(lon, lat);
    expect(Math.abs(e - 2_700_000)).toBeLessThan(1);
    expect(Math.abs(n - 1_100_000)).toBeLessThan(1);
  });
  it('round-trips', () => {
    const [lo, la] = lv95ToWgs84(2_744_190, 1_234_930);
    const [e, n] = wgs84ToLv95(lo, la);
    expect(Math.hypot(e - 2_744_190, n - 1_234_930)).toBeLessThan(1.5);
  });
});

describe('Swiss hiking time', () => {
  it('is 4.2 km/h on the flat, as the signage handbook specifies', () => {
    expect(60 / paceMinPerKm(0)).toBeCloseTo(4.2, 1);
  });
  it('is fastest on a gentle descent', () => {
    expect(paceMinPerKm(-5)).toBeLessThan(paceMinPerKm(0));
    expect(paceMinPerKm(-5)).toBeLessThan(paceMinPerKm(-15));
  });
  it('matches the chart: 1 km at +20 % takes about 32 minutes', () => {
    expect(segmentMinutes(1000, 200)).toBeGreaterThan(31);
    expect(segmentMinutes(1000, 200)).toBeLessThan(33.5);
  });
  it('extrapolates beyond ±40 % instead of clamping', () => {
    expect(paceMinPerKm(50)).toBeGreaterThan(paceMinPerKm(40));
  });
  it('rounds like a signpost', () => {
    expect(signpostMinutes(52)).toBe(50);
    expect(signpostMinutes(53)).toBe(55);
    expect(formatDuration(292, true)).toBe('4:50');
  });
});

describe('track helpers', () => {
  const line: XY[] = [[0, 0], [100, 0], [100, 55]];
  it('resamples every step and keeps the end vertex', () => {
    const pts = resample(line, 10);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([100, 55]);
    expect(pts.length).toBe(17);
    expect(polylineLength(pts)).toBeCloseTo(155, 5);
  });
  it('ignores altitude noise below the hysteresis threshold', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 1000 + (i % 2 ? 1 : -1));
    expect(climb(noisy, 3)).toEqual({ up: 0, down: 0 });
    expect(climb([1000, 1010, 1005, 1020, 990], 3)).toEqual({ up: 25, down: 35 });
  });
  it('simplifies a straight line to its ends', () => {
    expect(simplify([[0, 0], [1, 0.01], [2, 0], [3, 0.01], [4, 0]], 0.1)).toEqual([[0, 0], [4, 0]]);
  });
});

describe('insideRings', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6]] as [number, number][];
  it('finds points inside a ring', () => expect(insideRings([square], 5, 1)).toBe(true));
  it('treats a nested ring as a hole', () => expect(insideRings([square, hole], 5, 5)).toBe(false));
  it('rejects points outside', () => expect(insideRings([square], 11, 5)).toBe(false));
});
