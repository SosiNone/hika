import { DatabaseSync } from 'node:sqlite';
import type { BBox, RouteCategory } from '../../src/data/types';
import { clipToBox, polylineLength, type XY } from '../../src/geo/track';
import { downloadFile } from './download';
import { parseGpkgLines } from './gpkg';
import { latestItem } from './stac';

const COLLECTION = 'ch.astra.wanderland';

export interface OfficialRoute {
  /** "<route>.<stage>", as SchweizMobil and the geo.admin.ch API number them ("1.01", "951.00"). */
  id: string;
  number: string;
  name: string;
  from: string;
  to: string;
  category: RouteCategory;
  /** Chained route geometry. */
  line: XY[];
  /** Metres of the chain that could not be joined (gaps between parts). */
  gaps: number;
  /** Metres of route left out beyond a gap too wide to walk across (`MAX_GAP`). */
  dropped: number;
  /** SchweizMobil's own length of the stage (km, rounded), to check the chained line against. */
  distance: number;
}

/**
 * The Wanderland Schweiz GeoPackage, from the FSDI download service, which the fair-use terms send
 * bulk use to (one file, instead of an API request per route). It keeps its name across releases,
 * so it is cached per data date.
 */
async function wanderlandGpkg(): Promise<string> {
  const item = await latestItem(COLLECTION);
  const asset = Object.values(item.assets).find((a) => a.href.endsWith('.gpkg'));
  if (!asset) throw new Error(`${COLLECTION}: no GeoPackage among ${Object.keys(item.assets).join(', ')}`);
  return downloadFile(asset.href, `wanderland/${item.properties.datetime.slice(0, 10)}`);
}

/**
 * Every SchweizMobil hiking route and stage in Wanderland Schweiz (national, regional, local and
 * barrier-free), sorted by id. A few stages come twice, as two versions of the whole stage (each
 * with its full length): the first row is kept, as merging them would walk the stage twice.
 */
export async function loadWanderland(): Promise<OfficialRoute[]> {
  const db = new DatabaseSync(await wanderlandGpkg(), { readOnly: true });
  const names = new Map((db.prepare('SELECT NrR, NameR FROM Route').all() as { NrR: string; NameR: string }[]).map((r) => [r.NrR, r.NameR]));
  const rows = db.prepare('SELECT NrR, NrEtappe, NameS, NameZ, DistanzE, geom FROM Etappe ORDER BY NrR, NrEtappe, fid').all() as {
    NrR: string; NrEtappe: number; NameS: string; NameZ: string; DistanzE: number; geom: Uint8Array;
  }[];
  db.close();
  const stages = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const id = `${r.NrR}.${String(r.NrEtappe).padStart(2, '0')}`;
    if (!stages.has(id)) stages.set(id, r);
  }
  return [...stages].sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => {
    const { line, gaps, dropped } = chain(parseGpkgLines(s.geom).map((part) => part.map(([e, n]) => [e, n] as XY)));
    return {
      id, number: id.replace(/\.00$/, ''), name: names.get(s.NrR) ?? s.NrR, from: s.NameS, to: s.NameZ, category: category(Number(s.NrR)),
      line, gaps, dropped, distance: s.DistanzE,
    };
  });
}

/** SchweizMobil numbering: 1–7 national, 2-digit regional, 3-digit local. */
function category(n: number): RouteCategory {
  return n < 10 ? 'national' : n < 100 ? 'regional' : 'local';
}

/**
 * The widest step (m) a route walks: a gap between two parts, or one straight segment. Beyond it
 * lies a stretch the stage covers otherwise, drawn as a straight line or not at all: ViaGottardo
 * 7.07 (Luzern–Altdorf) crosses the lake by boat.
 */
export const MAX_GAP = 1000;

/**
 * Joins unordered, arbitrarily oriented line parts into one polyline: start at a part whose end
 * has no neighbour, then repeatedly append the part with the nearest endpoint. A step wider than
 * MAX_GAP splits the chain, and the longest piece is the line; `dropped` is the length of the rest.
 */
export function chain(parts: XY[][]): { line: XY[]; gaps: number; dropped: number } {
  const left = parts.filter((p) => p.length > 1).map((p) => [...p]);
  if (!left.length) return { line: [], gaps: 0, dropped: 0 };
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
  const pieces: XY[][] = [[line[0]]];
  for (let i = 1; i < line.length; i++) {
    if (d(line[i - 1], line[i]) > MAX_GAP) pieces.push([]);
    pieces[pieces.length - 1].push(line[i]);
  }
  const lengths = pieces.map(polylineLength), longest = lengths.indexOf(Math.max(...lengths));
  return { line: pieces[longest], gaps, dropped: lengths.reduce((s, l) => s + l, 0) - lengths[longest] };
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
