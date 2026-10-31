import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AreaKind, BBox, Place, PlaceKind } from '../../src/data/types';
import type { XY } from '../../src/geo/track';
import { downloadAsset, downloadFile } from './download';
import { parseGpkgRings } from './gpkg';
import { latestItem } from './stac';

/** swissNAMES3D object types worth showing to hikers, with kind and base label priority. */
const POINT_TYPES: Record<string, [PlaceKind, number]> = {
  'Alpiner Gipfel': ['summit', 100], Hauptgipfel: ['summit', 90], Gipfel: ['summit', 60], Haupthuegel: ['summit', 30],
  Felskopf: ['summit', 20], Huegel: ['summit', 10], Pass: ['pass', 60], Strassenpass: ['pass', 50],
  'Haltestelle Bahn': ['stop', 45], 'Haltestelle Bus': ['stop', 25], 'Uebrige Bahnen': ['lift', 40],
  Aussichtspunkt: ['view', 55], Wasserfall: ['water', 25], 'Grotte, Hoehle': ['cave', 25],
};
const POLYGON_TYPES: Record<string, [PlaceKind, number]> = { See: ['lake', 50], Grat: ['ridge', 20] };
const BUILDING_USES: Record<string, [PlaceKind, number]> = { 'Gasthof abgelegen': ['inn', 50], Schutzhuette: ['inn', 45] };
const POPULATION_PRIO: Record<string, number> = {
  '< 20': 5, '20 bis 49': 10, '50 bis 99': 15, '100 bis 999': 30, "1'000 bis 1'999": 45,
  "2'000 bis 9'999": 55, "10'000 bis 49'999": 70, "50'000 bis 100'000": 80, "> 100'000": 90,
};

/** Every hiker-relevant swissNAMES3D place in Switzerland (and Liechtenstein). */
export async function loadPlaces(): Promise<Place[]> {
  const item = await latestItem('ch.swisstopo.swissnames3d');
  const asset = Object.values(item.assets).find((a) => a.href.endsWith('.csv.zip'))!;
  const files = await downloadAsset(asset.href, 'swissnames3d', (n) => n.endsWith('.csv'));
  const places: Place[] = [];
  for (const file of files.filter((f) => /_(PKT|PLY)\.csv$/.test(f))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const head = lines[0].replace(/^﻿/, '').split(';');
    const col = (name: string) => head.indexOf(name);
    const [iUuid, iName, iType, iUse, iPop, iE, iN, iZ] = ['UUID', 'NAME', 'OBJEKTART', 'GEBAEUDENUTZUNG', 'EINWOHNERKATEGORIE', 'E', 'N', 'Z'].map(col);
    const polygons = file.endsWith('_PLY.csv');
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(';');
      if (c.length < head.length) continue;
      const type = c[iType];
      let spec = polygons ? POLYGON_TYPES[type] : POINT_TYPES[type] ?? (iUse >= 0 ? BUILDING_USES[c[iUse]] : undefined);
      if (!spec && type === 'Ort' && !polygons) spec = ['village', POPULATION_PRIO[c[iPop]] ?? 5];
      if (!spec) continue;
      places.push({ id: c[iUuid].replace(/[{}]/g, '').slice(0, 13), name: c[iName], kind: spec[0], e: +c[iE], n: +c[iN], alt: Math.round(+c[iZ]), prio: spec[1] });
    }
  }
  return dedupe(places);
}

/** A named swissNAMES3D area with its outline: a Grossregion (mountain range), landscape, main valley, hill chain or massif. */
export interface AreaFeature {
  uuid: string;
  kind: AreaKind;
  /** Every language variant, official names first. */
  names: string[];
  /** Outer rings and holes, even-odd. */
  rings: XY[][];
}

const AREA_KINDS: AreaKind[] = ['Grossregion', 'Landschaftsname', 'Haupttal', 'Huegelzug', 'Massiv'];

/**
 * The area outlines of swissNAMES3D. The CSV that `loadPlaces` reads has only a label point per
 * area, so they come from the GeoPackage, which only the 2026 release offers. Language variants
 * are rows with the same uuid and geometry, merged into one feature.
 */
export async function loadAreaFeatures(): Promise<AreaFeature[]> {
  const item = await latestItem('ch.swisstopo.swissnames3d');
  const asset = Object.values(item.assets).find((a) => a.href.endsWith('.gpkg'));
  if (!asset) throw new Error(`swissNAMES3D ${item.id} has no GeoPackage: ${Object.values(item.assets).map((a) => a.href).join(', ')}`);
  const db = new DatabaseSync(await downloadFile(asset.href, 'swissnames3d'), { readOnly: true });
  const tables = (db.prepare("SELECT table_name FROM gpkg_geometry_columns WHERE geometry_type_name LIKE '%POLYGON%'").all() as { table_name: string }[]).map((t) => t.table_name);
  if (tables.length !== 1) throw new Error(`expected one polygon table in swissNAMES3D, found ${tables.join(', ') || 'none'}`);
  const rows = db.prepare(`SELECT uuid, name, status, namen_typ, objektart, geom FROM "${tables[0]}" WHERE objektart IN (${AREA_KINDS.map(() => '?').join(',')}) ORDER BY uuid, name`).all(...AREA_KINDS) as {
    uuid: string; name: string; status: string; namen_typ: string; objektart: AreaKind; geom: Uint8Array;
  }[];
  db.close();
  const byUuid = new Map<string, { kind: AreaKind; names: { name: string; rank: number }[]; geom: Uint8Array }>();
  for (const r of rows) {
    // Official names before informal ones, and endonyms before exonyms.
    const rank = (r.status === 'offiziell' ? 0 : 2) + (r.namen_typ === 'Exonym' ? 1 : 0);
    const f = byUuid.get(r.uuid) ?? byUuid.set(r.uuid, { kind: r.objektart, names: [], geom: r.geom }).get(r.uuid)!;
    if (!f.names.some((n) => n.name === r.name)) f.names.push({ name: r.name, rank });
  }
  return [...byUuid].map(([uuid, f]) => ({
    uuid: uuid.replace(/[{}]/g, ''), kind: f.kind,
    names: f.names.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'de')).map((n) => n.name),
    rings: parseGpkgRings(f.geom).map((ring) => ring.map(([e, n]) => [e, n] as XY)),
  }));
}

/** The area features a seed name matches, ignoring case and accents, of the given kind if any. */
export function matchAreaFeatures(features: AreaFeature[], name: string, kind?: AreaKind): AreaFeature[] {
  const q = fold(name);
  return features.filter((f) => (!kind || f.kind === kind) && f.names.some((n) => fold(n) === q));
}

/** The same name and kind within 150 m (e.g. a lift's top and bottom record) counts once. */
function dedupe(places: Place[]): Place[] {
  const seen = new Map<string, Place[]>();
  return places.filter((p) => {
    const key = `${p.kind}:${p.name}`;
    const prev = seen.get(key) ?? [];
    if (prev.some((q) => Math.hypot(q.e - p.e, q.n - p.n) < 150)) return false;
    seen.set(key, [...prev, p]);
    return true;
  });
}

export const inBox = (p: { e: number; n: number }, [minE, minN, maxE, maxN]: BBox, pad = 0) =>
  p.e >= minE - pad && p.e <= maxE + pad && p.n >= minN - pad && p.n <= maxN + pad;

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Resolves a free-text place name ("Wildhaus, Gamplüt", "Säntis") to a swissNAMES3D place.
 * Exact matches (quality 3) beat matches on a comma-separated part ("Schwägalp" ~ "Schwägalp,
 * Passhöhe", 2), which beat prefix matches (1); ties go to the place nearest `near`, then to the
 * highest priority. Matches below `minQuality` don't count.
 */
export function resolvePlace(places: Place[], query: string, near: [number, number], kind?: Place['kind'], minQuality = 1): Place | undefined {
  const q = fold(query), qParts = query.split(',').map(fold);
  let best: Place | undefined, bestQ = 0, bestS = Infinity;
  for (const p of places) {
    if (kind && p.kind !== kind) continue;
    const name = fold(p.name), parts = p.name.split(',').map(fold);
    const quality = name === q ? 3 : parts.includes(q) || qParts.includes(name) ? 2 : name.startsWith(q + ' ') ? 1 : 0;
    if (quality < minQuality) continue;
    const score = Math.hypot(p.e - near[0], p.n - near[1]) / 1000 - p.prio / 10;
    if (quality > bestQ || (quality === bestQ && score < bestS)) { best = p; bestQ = quality; bestS = score; }
  }
  return best;
}

/** Abbreviations in SchweizMobil's route ends, spelled out as swissNAMES3D writes them. */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bCap\./g, 'Capanna'], [/\bCab\./g, 'Cabane'], [/\bM\./g, 'Monte'], [/\bS\./g, 'San'], [/\bStn\b/g, 'Station'], [/\bi\. ?E\./g, 'im Engadin'],
];

/**
 * Resolves a route end as SchweizMobil names it, for orienting the route: "Lugano (Comano)" is
 * Comano near Lugano, "Cap. Pairolo" the Capanna Pairolo, "Urner Boden" Urnerboden. Tries the
 * name, then with abbreviations spelled out, the place in brackets, the one before them, and the
 * name without spaces. Those must match a whole name (or one of its comma parts): a prefix match
 * of a generic word, the "Station" in "Glaris (Station)", would find any station.
 */
export function resolveRouteEnd(places: Place[], name: string, near: [number, number]): Place | undefined {
  const spelled = ABBREVIATIONS.reduce((s, [re, full]) => s.replace(re, full), name);
  const bracket = /^(.*?)\s*\((.*)\)\s*$/.exec(spelled);
  for (const [q, min] of [[name, 1], ...[spelled, ...(bracket ? [bracket[2], bracket[1]] : []), spelled.replace(/\s+/g, '')].map((v) => [v, 2])] as [string, number][]) {
    const p = resolvePlace(places, q, near, undefined, min);
    if (p) return p;
  }
  return undefined;
}
