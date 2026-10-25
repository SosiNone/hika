import { describe, expect, it } from 'vitest';
import { nextWaypoint } from '../src/data/load';

describe('nextWaypoint', () => {
  // 10 m samples; waypoints at 0, 1.5 and 3 km.
  const r = { step: 10, waypoints: [0, 1.5, 3].map((km, k) => ({ place: `p${k}`, km, alt: 0, time: 0 })) };

  it('counts the departure as passed from the first sample', () => expect(nextWaypoint(r, 0)).toBe(1));
  it('keeps a waypoint next until the hiker reaches it', () => expect(nextWaypoint(r, 149)).toBe(1));
  it('moves on once the hiker stands on it', () => expect(nextWaypoint(r, 150)).toBe(2));
  it('returns -1 on arrival', () => expect(nextWaypoint(r, 300)).toBe(-1));
});
