/**
 * Sanity checks for the atlas (format 3): `npm run check:atlas` checks .atlas/v3/,
 * `npm run check:atlas -- <dir>` another one (a hika-data checkout). It reads the region configs in
 * regions/. Exits non-zero when a check fails, so it can guard CI or a rebuild.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodeGrid, decodeRoute, decodeTrails } from '../src/data/codec';
import { CELL, routeWindow, TILE, TILE_CELLS, TRAIL_BIAS, tileBox, tileKey, tileOf, tilesCovering } from '../src/data/tiles';
import { ATLAS_FORMAT, SPARK_POINTS, type AtlasManifest, type BBox, type Catalogue, type Locator, type Place, type RegionConfig, type RegionIndex } from '../src/data/types';
import { insideRings, type XY } from '../src/geo/track';
import { nearbyRegion, routesOf } from '../src/regions';
import { emptyCells } from './lib/coverage';
import { formatIndex } from './lib/regions';
import { routeProblems } from './lib/route';
import { overlaps } from './lib/scout';

const DIR = process.argv[2] ?? '.atlas/v3';
/**
 * The most one window may cost over the wire (gzipped, as GitHub Pages serves it): its tiles, plus
 * the catalogue, the locator and the routes the region lists. A region bundle with its imagery
 * cost 2.3–2.5 MB.
 */
const BUDGET = 3 * 1024 * 1024;

let failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed++; };
const read = <T>(rel: string) => JSON.parse(readFileSync(`${DIR}/${rel}`, 'utf8')) as T;
const size = (rel: string) => (existsSync(`${DIR}/${rel}`) ? statSync(`${DIR}/${rel}`).size : 0);
const gzipped = new Map<string, number>();
const wire = (rel: string) => {
  if (!gzipped.has(rel)) gzipped.set(rel, existsSync(`${DIR}/${rel}`) ? gzipSync(readFileSync(`${DIR}/${rel}`)).length : 0);
  return gzipped.get(rel)!;
};
const arrayBuffer = (rel: string) => { const b = readFileSync(`${DIR}/${rel}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };

/** Gzipped bytes of the tiles a window needs. */
const windowBytes = (b: BBox) => tilesCovering(b).reduce((s, [e, n]) => {
  const key = tileKey(e, n);
  return s + wire(`terrain/${key}.bin`) + wire(`trails/${key}.bin`) + wire(`places/${key}.json`);
}, 0);

console.log(DIR);
const manifest = read<AtlasManifest>('manifest.json');
check(manifest.format === ATLAS_FORMAT, `atlas format ${manifest.format} (the pipeline writes ${ATLAS_FORMAT})`);
check(manifest.tile === TILE && manifest.cell === CELL, `${manifest.tile / 1000} km tiles of ${manifest.cell} m cells`);
const locator = read<Locator>('locator.json');
check(size(locator.file) === locator.cols * locator.rows * 2, `${locator.file}: ${locator.cols}×${locator.rows} national relief`);
const rings = locator.border.map((flat) => Array.from({ length: flat.length / 2 }, (_, k): XY => [flat[2 * k], flat[2 * k + 1]]));

console.log('\ntiles');
const listed = new Set(manifest.tiles);
check([...listed].sort().join() === manifest.tiles.join() && listed.size === manifest.tiles.length, `${listed.size} tiles, sorted and unique`);
for (const [dir, ext] of [['terrain', '.bin'], ['trails', '.bin'], ['places', '.json']]) {
  const files = existsSync(`${DIR}/${dir}`) ? readdirSync(`${DIR}/${dir}`) : [];
  const stray = files.filter((f) => !listed.has(f.slice(0, -ext.length)) || !f.endsWith(ext));
  const missing = manifest.tiles.filter((k) => !files.includes(k + ext));
  check(!stray.length && !missing.length, `${dir}/: ${files.length} files${stray.length ? `, not in the manifest: ${stray.slice(0, 5).join(', ')}` : ''}${missing.length ? `, missing: ${missing.slice(0, 5).join(', ')}` : ''}`);
}
const heights = new Map<string, Uint16Array>();
let cells = 0, emptyInside = 0, trailLines = 0, placeCount = 0;
const bad: string[] = [], holes: string[] = [];
for (const key of manifest.tiles) {
  const [e, n] = key.split('_').map((v) => +v * 1000);
  try {
    const h = decodeGrid(readFileSync(`${DIR}/terrain/${key}.bin`), TILE_CELLS, TILE_CELLS);
    heights.set(key, h);
    cells += h.length;
    emptyInside += emptyCells(h, { bbox: tileBox(e, n), grid: { cols: TILE_CELLS, rows: TILE_CELLS, cell: CELL }, locator }).inside;
    // A whole empty 1 km block well inside the border is a swissALTI3D tile that failed to download.
    const per = 1000 / CELL;
    for (let bj = 0; bj < TILE_CELLS / per; bj++) for (let bi = 0; bi < TILE_CELLS / per; bi++) {
      let empty = true;
      for (let j = bj * per; j < (bj + 1) * per && empty; j++) for (let i = bi * per; i < (bi + 1) * per; i++) if (h[j * TILE_CELLS + i]) { empty = false; break; }
      const ce = e + bi * 1000 + 500, cn = n + TILE - bj * 1000 - 500;
      if (empty && [[0, 0], [-400, -400], [400, -400], [-400, 400], [400, 400]].every(([de, dn]) => insideRings(rings, ce + de, cn + dn))) holes.push(`${key} block ${bi},${bj}`);
    }
    const t = decodeTrails(arrayBuffer(`trails/${key}.bin`));
    trailLines += t.cls.length;
    // Every line is stored in the tile that holds the centre of its extent.
    for (let l = 0; l < t.cls.length; l++) {
      const xs: number[] = [], ys: number[] = [];
      for (let v = t.offsets[l]; v < t.offsets[l + 1]; v++) { xs.push(t.xy[2 * v] - TRAIL_BIAS); ys.push(t.xy[2 * v + 1] - TRAIL_BIAS); }
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      if (cx < -0.5 || cx >= TILE + 0.5 || cy < -0.5 || cy >= TILE + 0.5 || t.cls[l] > 2) { bad.push(`${key}: trail line ${l}`); break; }
    }
    const places = read<Place[]>(`places/${key}.json`);
    placeCount += places.length;
    const off = places.find((p) => tileKey(...tileOf(p.e, p.n)) !== key);
    if (off) bad.push(`${key}: place ${off.name} lies outside`);
  } catch (err) {
    bad.push(`${key}: ${(err as Error).message}`);
  }
}
check(!bad.length, `tiles decode, lines and places sit in their tiles (${trailLines} trail lines, ${placeCount} places)${bad.length ? `: ${bad.slice(0, 5).join('; ')}` : ''}`);
// Allow 1 % for the 400 m simplification of the border.
check(emptyInside / cells < 0.01, `${emptyInside} empty cells inside Switzerland (${((emptyInside / cells) * 100).toFixed(2)} %)`);
check(!holes.length, `no 1 km block missing inside Switzerland${holes.length ? `: ${holes.slice(0, 5).join(', ')}` : ''}`);

console.log('\nroutes');
const catalogue = read<Catalogue>('catalogue.json');
const ids = catalogue.routes.map((r) => r.id);
check(catalogue.format === ATLAS_FORMAT && manifest.routes === ids.length, `catalogue: ${ids.length} routes (manifest says ${manifest.routes})`);
check(new Set(ids).size === ids.length && [...ids].sort().join() === ids.join(), 'route ids are unique and sorted');
const files = existsSync(`${DIR}/routes`) ? readdirSync(`${DIR}/routes`) : [];
const strays = files.filter((f) => !ids.includes(f.replace(/\.bin$/, '')));
check(!strays.length && files.length === ids.length, `routes/: ${files.length} files${strays.length ? `, not in the catalogue: ${strays.slice(0, 5).join(', ')}` : ''}`);
/** What every window costs on top of its tiles and routes: the atlas-wide files. */
const fixed = ['manifest.json', 'catalogue.json', 'regions.json', 'locator.json', locator.file].reduce((s, f) => s + wire(f), 0);
const regionIds = new Set(readdirSync('regions').filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
/** The heaviest neighbourhood page, reported after the routes. */
let heaviest = { id: '', bytes: 0 };
for (const entry of catalogue.routes) {
  const problems: string[] = [];
  try {
    const r = decodeRoute(arrayBuffer(`routes/${entry.id}.bin`));
    if (r.id !== entry.id) problems.push(`file holds ${r.id}`);
    for (const k of ['number', 'name', 'from', 'to', 'source', 'category', 'stats'] as const) if (JSON.stringify(r[k]) !== JSON.stringify(entry[k])) problems.push(`catalogue ${k} differs from the file`);
    problems.push(...routeProblems(r));
    const named = new Set(r.places.map((p) => p.id));
    if (r.waypoints.some((w) => !named.has(w.place))) problems.push('a waypoint names a place the file lacks');
    const [minE, minN, maxE, maxN] = entry.bbox;
    if (!r.e.every((e, i) => e >= minE && e <= maxE && r.n[i] >= minN && r.n[i] <= maxN)) problems.push('samples outside its bbox');
    // The terrain under every sample in Switzerland is in the atlas. A tile left out has no data at
    // all, which is right abroad: the Walserweg Gottardo (62.01) ends in Italy.
    if (r.e.some((e, i) => !heights.has(tileKey(...tileOf(e, r.n[i]))) && insideRings(rings, e, r.n[i]))) problems.push('runs over a tile the atlas lacks');
    // A route no region lists opens on its neighbourhood: its window and every route that crosses
    // it, which fit the budget too. A region's routes are weighed with the region, below.
    if (!entry.regions.length) {
      const near = nearbyRegion(entry, catalogue.routes);
      const own = windowBytes(near.bbox) + fixed + routesOf(near, catalogue.routes).reduce((s, r) => s + wire(`routes/${r.id}.bin`), 0);
      if (own >= BUDGET) problems.push(`its neighbourhood costs ${(own / 1024 / 1024).toFixed(1)} MB gzipped`);
      if (own > heaviest.bytes) heaviest = { id: entry.id, bytes: own };
    }
  } catch (err) {
    problems.push((err as Error).message);
  }
  if (entry.spark.length !== SPARK_POINTS) problems.push(`${entry.spark.length} spark points`);
  // Most routes are on no region's list; those that are name real regions.
  if (entry.regions.some((id) => !regionIds.has(id))) problems.push(`unknown regions in ${entry.regions.join(', ')}`);
  check(!problems.length, `${(entry.number ?? entry.id).padEnd(32)} ${entry.stats.km.toFixed(1).padStart(5)} km ↑${entry.stats.up} ↓${entry.stats.down} ${entry.stats.time} min${problems.length ? `: ${problems.join('; ')}` : ''}`);
}

if (heaviest.id) console.log(`     heaviest neighbourhood: ${heaviest.id}, ${(heaviest.bytes / 1024 / 1024).toFixed(1)} MB gzipped (budget ${BUDGET / 1024 / 1024} MB)`);

console.log('\nregions');
const index = read<RegionIndex>('regions.json');
check(index.version === 3 && readFileSync(`${DIR}/regions.json`, 'utf8') === formatIndex(index), `regions.json: version ${index.version}, one region per line`);
const titles = index.regions.map((r) => r.title);
check(titles.join() === [...titles].sort((a, b) => a.localeCompare(b, 'de')).join(), 'regions are sorted by title');
const byId = new Map(catalogue.routes.map((r) => [r.id, r]));
const listing = new Set(catalogue.routes.flatMap((r) => r.regions));
check([...listing].every((id) => index.regions.some((r) => r.id === id)), `every region a route names is in regions.json (${index.regions.length})`);
for (const summary of index.regions) {
  const { id } = summary;
  const problems: string[] = [];
  const cfg = regionIds.has(id) ? (JSON.parse(readFileSync(`regions/${id}.json`, 'utf8')) as RegionConfig) : null;
  if (!cfg) problems.push(`no regions/${id}.json`);
  else if ((['title', 'subtitle', 'cantons', 'bbox'] as const).some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(summary[k]))) problems.push('differs from its config');
  const routes = catalogue.routes.filter((r) => r.regions.includes(id));
  if (routes.length !== summary.routes || routes.filter((r) => r.source === 'curated').length !== summary.classics) problems.push(`lists ${routes.length} routes, says ${summary.routes}`);
  if (byId.get(summary.defaultRoute)?.regions.includes(id) !== true) problems.push(`default route ${summary.defaultRoute} is not on its list`);
  if (!(summary.alt[0] > 185 && summary.alt[1] < 4700 && summary.alt[0] < summary.alt[1])) problems.push(`altitudes ${summary.alt.join('–')} m`);
  check(!problems.length, `${id}: ${routes.length} routes, default ${summary.defaultRoute}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  // The heaviest window the region opens: any of its routes, joined with its box where that fits.
  const routeFiles = routes.reduce((s, r) => s + wire(`routes/${r.id}.bin`), 0);
  const worst = Math.max(...routes.map((r) => windowBytes(routeWindow(r.bbox, summary.bbox))));
  check(fixed + routeFiles + worst < BUDGET, `${id}: heaviest window ${((fixed + routeFiles + worst) / 1024 / 1024).toFixed(1)} MB gzipped (budget ${BUDGET / 1024 / 1024} MB)`);
}
const clashes = index.regions.flatMap((a, i) => index.regions.slice(i + 1).filter((b) => overlaps(a.bbox, b.bbox)).map((b) => `${a.id} / ${b.id}`));
check(!clashes.length, clashes.length ? `overlapping regions: ${clashes.join(', ')}` : 'no two regions overlap');

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
