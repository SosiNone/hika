import type { XY } from '../../src/geo/track';
import { fetchCached } from './http';

const PROFILE = 'https://api3.geo.admin.ch/rest/services/profile.json';
const CHUNK = 1000;

interface ProfilePoint { dist: number; easting: number; northing: number; alts: { DTM2?: number; COMB?: number; DTM25?: number } }

/**
 * swissALTI3D (DTM2) heights at each of `pts` from the geo.admin.ch profile service.
 * The service keeps input vertices and may add points on long segments, so results are
 * matched back to inputs by coordinates. Requests are chunked under the 5000-point limit.
 */
export async function profileHeights(pts: XY[]): Promise<number[]> {
  const out = new Array<number>(pts.length).fill(NaN);
  for (let start = 0; start < pts.length - 1; start += CHUNK - 1) {
    const slice = pts.slice(start, Math.min(pts.length, start + CHUNK));
    const geom = JSON.stringify({ type: 'LineString', coordinates: slice.map(([e, n]) => [+e.toFixed(1), +n.toFixed(1)]) });
    const buf = await fetchCached(`${PROFILE}?sr=2056&nb_points=${slice.length}&distinct_points=true`, {
      method: 'POST', body: geom, headers: { 'content-type': 'application/json' },
    });
    const res = JSON.parse(buf.toString('utf8')) as ProfilePoint[];
    let j = 0;
    for (let i = 0; i < slice.length; i++) {
      // Advance to the returned point closest to this input vertex (results are ordered along the line).
      let best = Infinity;
      for (let k = j; k < res.length; k++) {
        const d = Math.hypot(res[k].easting - slice[i][0], res[k].northing - slice[i][1]);
        if (d < best) { best = d; j = k; } else if (d > best + 50) break;
      }
      const a = res[j].alts;
      out[start + i] = a.DTM2 ?? a.COMB ?? a.DTM25 ?? NaN;
    }
  }
  return out;
}
