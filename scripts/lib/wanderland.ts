import type { BBox, RouteCategory } from '../../src/data/types';
import { clipToBox, polylineLength, type XY } from '../../src/geo/track';
import { fetchJson } from './http';

const API = 'https://api3.geo.admin.ch/rest/services/api/MapServer';
const LAYER = 'ch.astra.wanderland';

export interface OfficialRoute {
  id: string;
  number: string;
  name: string;
  from: string;
  to: string;
  category: RouteCategory;
  /** Full chained route geometry (may extend beyond the region). */
  line: XY[];
  /** Metres of the chain that could not be joined (gaps between parts). */
  gaps: number;
}

interface Feature { id: string | number; attributes?: Record<string, unknown>; properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } }

/** The most results `identify` returns per request. */
const PAGE = 200;

/** SchweizMobil "Wanderland" routes (national, regional, local) touching `bbox`, page by page. */
export async function listRoutes(bbox: BBox): Promise<{ id: string; label: string }[]> {
  const env = bbox.join(','), found = new Map<string, string>();
  for (let offset = 0; ; offset += PAGE) {
    const url = `${API}/identify?geometryType=esriGeometryEnvelope&geometry=${env}&imageDisplay=1000,1000,96&mapExtent=${env}` +
      `&tolerance=0&layers=all:${LAYER}&returnGeometry=false&sr=2056&limit=${PAGE}${offset ? `&offset=${offset}` : ''}`;
    const res = await fetchJson<{ results: Feature[] }>(url);
    for (const f of res.results) found.set(String(f.id), String((f.attributes ?? f.properties)!.label));
    if (res.results.length < PAGE) break;
  }
  return [...found].map(([id, label]) => ({ id, label }));
}

export async function fetchRoute(id: string): Promise<OfficialRoute> {
  const url = `${API}/find?layer=${LAYER}&searchText=${encodeURIComponent(id)}&searchField=id&returnGeometry=true&geometryFormat=geojson&sr=2056&contains=false`;
  const res = await fetchJson<{ results: Feature[] }>(url);
  const f = res.results.find((r) => String(r.id) === id);
  if (!f?.geometry) throw new Error(`route ${id} not found`);
  const props = (f.attributes ?? f.properties)!;
  const title = String(props.chmobil_title ?? props.label);
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(title);
  const [from, to] = m ? splitEnds(m[2]) : [title, title];
  const parts = (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates) as XY[][];
  const { line, gaps } = chain(parts.map((p) => p.map(([e, n]) => [e, n] as XY)));
  return { id, number: id.replace(/\.00$/, ''), name: m ? m[1] : title, from, to, category: category(Number(props.chmobil_route_number)), line, gaps };
}

/** "Wildhaus, Gamplüt - Säntis" -> ["Wildhaus, Gamplüt", "Säntis"]; hyphens inside names stay. */
function splitEnds(s: string): [string, string] {
  const i = s.indexOf(' - ');
  return i < 0 ? [s, s] : [s.slice(0, i).trim(), s.slice(i + 3).trim()];
}

/** SchweizMobil numbering: 1–7 national, 2-digit regional, 3-digit local. */
function category(n: number): RouteCategory {
  return n < 10 ? 'national' : n < 100 ? 'regional' : 'local';
}

/**
 * Joins unordered, arbitrarily oriented line parts into one polyline: start at a part whose
 * end has no neighbour, then repeatedly append the part with the nearest endpoint.
 */
export function chain(parts: XY[][]): { line: XY[]; gaps: number } {
  const left = parts.filter((p) => p.length > 1).map((p) => [...p]);
  if (!left.length) return { line: [], gaps: 0 };
  const d = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const nearestOther = (pt: XY, self: number) =>
    Math.min(...left.map((p, i) => (i === self ? Infinity : Math.min(d(pt, p[0]), d(pt, p[p.length - 1])))));
  // A terminal endpoint: the one farthest from every other part.
  let startIdx = 0, startAtHead = true, best = -1;
  left.forEach((p, i) => {
    for (const head of [true, false]) {
      const gap = nearestOther(head ? p[0] : p[p.length - 1], i);
      if (gap > best) { best = gap; startIdx = i; startAtHead = head; }
    }
  });
  let line = left.splice(startIdx, 1)[0];
  if (!startAtHead) line.reverse();
  let gaps = 0;
  while (left.length) {
    const tail = line[line.length - 1];
    let bi = 0, flip = false, bd = Infinity;
    left.forEach((p, i) => {
      const dh = d(tail, p[0]), dt = d(tail, p[p.length - 1]);
      if (dh < bd) { bd = dh; bi = i; flip = false; }
      if (dt < bd) { bd = dt; bi = i; flip = true; }
    });
    const next = left.splice(bi, 1)[0];
    if (flip) next.reverse();
    if (bd > 1) gaps += bd;
    line = line.concat(bd < 0.5 ? next.slice(1) : next);
  }
  return { line, gaps };
}

/** The longest piece of `line` inside `bbox`, with flags for whether it was cut at either end. */
export function clipRoute(line: XY[], bbox: BBox): { piece: XY[]; clipped: [boolean, boolean]; insideShare: number } {
  const pieces = clipToBox(line, bbox);
  if (!pieces.length) return { piece: [], clipped: [true, true], insideShare: 0 };
  const lens = pieces.map(polylineLength);
  const piece = pieces[lens.indexOf(Math.max(...lens))];
  const same = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1;
  return {
    piece,
    clipped: [!same(piece[0], line[0]), !same(piece[piece.length - 1], line[line.length - 1])],
    insideShare: lens.reduce((s, l) => s + l, 0) / polylineLength(line),
  };
}
