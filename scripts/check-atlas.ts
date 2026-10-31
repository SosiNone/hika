/**
 * Sanity checks for the atlas (format 4): `npm run check:atlas` checks .atlas/v4/,
 * `npm run check:atlas -- <dir>` another one (a hika-data checkout). It reads the region configs in
 * regions/. Exits non-zero when a check fails, so it can guard CI or a rebuild.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { decodeGrid, decodeRoute, decodeTrails } from '../src/data/codec';
import { CELL, routeWindow, TILE, TILE_CELLS, TRAIL_BIAS, tileBox, tileKey, tileOf, tilesCovering } from '../src/data/tiles';
import { decodeArc, decodeRings, insideFlat } from '../src/data/shapes';
import { ATLAS_FORMAT, SPARK_POINTS, type AtlasManifest, type BBox, type Catalogue, type Locator, type Place, type RegionConfig, type RegionIndex } from '../src/data/types';
import { insideRings, type XY } from '../src/geo/track';
import { RANGES } from './lib/areas';
import { emptyCells } from './lib/coverage';
import { formatIndex } from './lib/regions';
import { routeProblems } from './lib/route';

const DIR = process.argv[2] ?? '.atlas/v4';
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
const detail = locator.detail;
check(!!detail && size(detail.file) === detail.cols * detail.rows * 2, `${detail?.file}: ${detail?.cols}×${detail?.rows} relief for the zoomed map, ${((wire(detail?.file ?? '') / 1024)).toFixed(0)} kB gzipped, loaded on demand`);
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
const configs = new Map(readdirSync('regions').filter((f) => f.endsWith('.json')).map((f) => {
  const cfg = JSON.parse(readFileSync(`regions/${f}`, 'utf8')) as RegionConfig;
  return [cfg.id, cfg];
}));
const index = read<RegionIndex>('regions.json');
const arcs = index.arcs.map(decodeArc);
/** Each area's outline, with its extent for a quick reject. */
const outlines = index.regions.map((r) => ({ id: r.id, range: r.range, bbox: r.bbox, rings: decodeRings(arcs, r.rings) }));
const areaAt = (e: number, n: number) => outlines.filter((o) => e >= o.bbox[0] && e <= o.bbox[2] && n >= o.bbox[1] && n <= o.bbox[3] && insideFlat(o.rings, e, n));
/** Samples 100 m apart: route files hold one every 10 m. */
const SHARE_STEP = 10;
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
    // The areas that list it hold their share of it, measured on the outlines the app draws (which
    // are simplified, hence the 5 points of slack): its home area holds the most of it (a curated
    // hike's home is the area that defines it), and every other at least its `minInside`.
    const share = new Map<string, number>();
    for (let i = 0; i < r.e.length; i += SHARE_STEP) for (const o of areaAt(r.e[i], r.n[i])) share.set(o.id, (share.get(o.id) ?? 0) + 1);
    const samples = Math.ceil(r.e.length / SHARE_STEP), of = (id: string) => (share.get(id) ?? 0) / samples;
    const most = Math.max(0, ...share.values()) / samples;
    const [home, ...others] = entry.regions;
    if (entry.source === 'curated') {
      if (!configs.get(home)?.curated.some((h) => `c-${h.id}` === entry.id)) problems.push(`${home} does not define it`);
    } else if (home && index.regions.some((x) => x.id === home) && of(home) < most - 0.05) problems.push(`home area ${home} holds ${Math.round(of(home) * 100)} %, another ${Math.round(most * 100)} %`);
    for (const id of others) if (of(id) < (configs.get(id)?.minInside ?? 0) - 0.05) problems.push(`${id} holds only ${Math.round(of(id) * 100)} % of it`);
  } catch (err) {
    problems.push((err as Error).message);
  }
  if (entry.spark.length !== SPARK_POINTS) problems.push(`${entry.spark.length} spark points`);
  // Every route has a home area (nationally), and names only real ones.
  if (!entry.regions.length && index.regions.length === configs.size) problems.push('no area lists it');
  if (entry.regions.some((id) => !configs.has(id))) problems.push(`unknown areas in ${entry.regions.join(', ')}`);
  check(!problems.length, `${(entry.number ?? entry.id).padEnd(32)} ${entry.stats.km.toFixed(1).padStart(5)} km ↑${entry.stats.up} ↓${entry.stats.down} ${entry.stats.time} min${problems.length ? `: ${problems.join('; ')}` : ''}`);
}

console.log('\nareas and ranges');
check(index.version === 4 && readFileSync(`${DIR}/regions.json`, 'utf8') === formatIndex(index), `regions.json: version ${index.version}, one range, area or arc per line`);
const titles = index.regions.map((r) => r.title);
check(titles.join() === [...titles].sort((a, b) => a.localeCompare(b, 'de')).join(), 'areas are sorted by title');
const rangeIds = index.ranges.map((r) => r.id);
check(rangeIds.join() === RANGES.map((r) => r.id).filter((id) => rangeIds.includes(id)).join(), `ranges in their fixed order: ${rangeIds.join(', ')}`);
const names = [...index.regions.map((r) => r.id), ...index.regions.flatMap((r) => r.aliases)];
check(new Set(names).size === names.length, 'area ids and aliases are unique');
const strayRange = index.regions.filter((r) => !rangeIds.includes(r.range)).map((r) => r.id);
const membersDiffer = index.ranges.filter((g) => g.areas.join() !== index.regions.filter((r) => r.range === g.id).map((r) => r.id).sort().join()).map((g) => g.id);
check(!strayRange.length && !membersDiffer.length && index.ranges.every((g) => g.areas.length), `every area is in a range and every range has areas${strayRange.length ? `; no range for ${strayRange.join(', ')}` : ''}${membersDiffer.length ? `; members differ in ${membersDiffer.join(', ')}` : ''}`);
const refs = [...index.ranges, ...index.regions].flatMap((x) => x.rings.flat());
const shortRings = [...index.ranges, ...index.regions].filter((x) => decodeRings(arcs, x.rings).some((ring) => ring.length < 8)).map((x) => x.id);
check(refs.every((ref) => (ref >= 0 ? ref : -ref - 1) < arcs.length) && !shortRings.length, `outlines decode from ${arcs.length} arcs${shortRings.length ? `; rings under 4 points in ${shortRings.join(', ')}` : ''}`);
// The areas tile Switzerland: every point of a 2 km grid inside the border is in exactly one area,
// and in the range of that area. Points near a border (within 300 m of one) are left out, as the
// outlines are simplified.
if (index.regions.length === configs.size) {
  const ranges = index.ranges.map((g) => ({ id: g.id, bbox: g.bbox, rings: decodeRings(arcs, g.rings) }));
  const rangeAt = (e: number, n: number) => ranges.filter((g) => e >= g.bbox[0] && e <= g.bbox[2] && n >= g.bbox[1] && n <= g.bbox[3] && insideFlat(g.rings, e, n)).map((g) => g.id).join();
  const at = (e: number, n: number) => areaAt(e, n).map((o) => o.id).join();
  let points = 0;
  const wrong: string[] = [];
  for (let n = locator.bbox[1] + 1000; n < locator.bbox[3]; n += 2000) for (let e = locator.bbox[0] + 1000; e < locator.bbox[2]; e += 2000) {
    if (!insideRings(rings, e, n)) continue;
    const here = at(e, n);
    if ([[300, 0], [-300, 0], [0, 300], [0, -300]].some(([de, dn]) => at(e + de, n + dn) !== here || !insideRings(rings, e + de, n + dn))) continue;
    points++;
    const ids = here ? here.split(',') : [];
    const range = index.regions.find((r) => r.id === ids[0])?.range;
    if (ids.length !== 1 || rangeAt(e, n) !== range) wrong.push(`${e},${n}: ${ids.join('+') || 'no area'}${ids.length === 1 ? ` but range ${rangeAt(e, n) || 'none'}` : ''}`);
  }
  check(!wrong.length, `the areas tile Switzerland, in their ranges (${points} points tested)${wrong.length ? `: ${wrong.slice(0, 5).join('; ')}` : ''}`);
}
const byId = new Map(catalogue.routes.map((r) => [r.id, r]));
const listing = new Set(catalogue.routes.flatMap((r) => r.regions));
check([...listing].every((id) => index.regions.some((r) => r.id === id)), `every area a route names is in regions.json (${index.regions.length})`);
for (const summary of index.regions) {
  const { id } = summary;
  const problems: string[] = [];
  const cfg = configs.get(id);
  if (!cfg) problems.push(`no regions/${id}.json`);
  else if ((['title', 'subtitle', 'cantons'] as const).some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(summary[k])) || JSON.stringify(cfg.aliases ?? []) !== JSON.stringify(summary.aliases) || (cfg.range && cfg.range !== summary.range)) problems.push('differs from its config');
  const routes = catalogue.routes.filter((r) => r.regions.includes(id));
  if (routes.length !== summary.routes || routes.filter((r) => r.source === 'curated').length !== summary.classics) problems.push(`lists ${routes.length} routes, says ${summary.routes}`);
  if (byId.get(summary.defaultRoute)?.regions.includes(id) !== true) problems.push(`default route ${summary.defaultRoute} is not on its list`);
  if (!(summary.alt[0] > 185 && summary.alt[1] < 4700 && summary.alt[0] < summary.alt[1])) problems.push(`altitudes ${summary.alt.join('–')} m`);
  const few = routes.length < 12 ? ' (few)' : routes.length > 45 ? ' (many)' : '';
  check(!problems.length, `${id}: ${routes.length} routes${few}, default ${summary.defaultRoute}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  // The heaviest window the area opens: any of its routes, joined with its extent where that fits.
  const routeFiles = routes.reduce((s, r) => s + wire(`routes/${r.id}.bin`), 0);
  const worst = Math.max(...routes.map((r) => windowBytes(routeWindow(r.bbox, summary.bbox))));
  check(fixed + routeFiles + worst < BUDGET, `${id}: heaviest window ${((fixed + routeFiles + worst) / 1024 / 1024).toFixed(2)} MB gzipped (budget ${BUDGET / 1024 / 1024} MB)`);
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
