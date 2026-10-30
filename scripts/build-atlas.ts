/**
 * Builds the atlas (format 3, see AGENTS.md) from swisstopo open data: `npm run build:atlas`.
 * It covers Switzerland: every tile with Swiss ground, every SchweizMobil route whole with the
 * terrain window around it, and the regions of regions/*.json with their curated hikes. Writes
 * .atlas/v3/ (or `--out <dir>`, such as a checkout of the hika-data repo) and removes tile and
 * route files that are no longer in it. `--dry-run` only reports the footprint. `--region <id>`
 * (repeatable) builds the footprint of those regions only, their boxes and the routes they list,
 * for trying out a change: the atlas in the output directory then holds just that.
 * Downloads are cached in .cache/. Rebuilding from unchanged data leaves every file as it was.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeGrid, encodeRoute, encodeTrails } from '../src/data/codec';
import { CELL, routeWindow, stitchGrid, TILE, TILE_CELLS, TRAIL_BIAS, tileBox, tileKey, tileOf, tilesCovering } from '../src/data/tiles';
import { ATLAS_FORMAT, SPARK_POINTS, type AtlasManifest, type AtlasRoute, type BBox, type Catalogue, type CatalogueEntry, type Place, type RegionConfig, type RegionSummary } from '../src/data/types';
import { insideRings, polylineLength, type XY } from '../src/geo/track';
import { TrailGraph } from './lib/graph';
import { mapLimit } from './lib/http';
import { buildLocator, CH_BBOX, loadBoundaries } from './lib/locator';
import { inBox, loadPlaces, resolvePlace, resolveRouteEnd } from './lib/names';
import { formatIndex, regionIndex, summariseRegion } from './lib/regions';
import { finishRoute, round1, STEP, type RouteMeta } from './lib/route';
import { SOURCES } from './lib/sources';
import { buildTerrain, encodeU16, sampleTiles } from './lib/terrain';
import { loadTrails, SegmentIndex, trailsData } from './lib/trails';
import { clipRoute, loadWanderland, MAX_GAP } from './lib/wanderland';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt >= 0 ? args[outAt + 1] : '.atlas/v3';
const dryRun = args.includes('--dry-run');
/** Curated hikes are routed on the trails this far around their region. */
const CURATED_PAD = 5000;
/** Places within this distance of a route can become its waypoints (the widest reach, a lake, is 350 m; a start or end looks 600 m). */
const PLACE_PAD = 700;
/**
 * A route with less of its length in Switzerland is left out: swissALTI3D has no terrain beyond
 * the border (Liechtenstein's routes are in Wanderland Schweiz too).
 */
const MIN_SWISS = 0.5;

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

/** Files written in this run, relative to OUT: the rest of the tile and route directories is stale. */
const written = new Set<string>();
/** Whether any file differs from what was on disk; only then does `generated` move. */
let changed = false;
const write = (rel: string, data: ArrayBufferView | string) => {
  written.add(rel);
  const file = `${OUT}/${rel}`, bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (existsSync(file) && readFileSync(file).equals(bytes)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  changed = true;
};

const { border } = await loadBoundaries();
const allConfigs = readdirSync('regions').filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(`regions/${f}`, 'utf8')) as RegionConfig);
/** A route a region excludes is left out of the atlas altogether (974.00 runs in Liechtenstein, where there is no terrain). */
const excluded = new Set(allConfigs.flatMap((c) => c.excludeRoutes));
const only = args.flatMap((a, i) => (args[i - 1] === '--region' ? [a] : []));
const configs = only.length ? allConfigs.filter((c) => only.includes(c.id)) : allConfigs;
if (configs.length !== (only.length || allConfigs.length)) throw new Error(`unknown region in ${only.join(', ')}`);
const national = !only.length;
log(national ? `Switzerland, ${configs.length} regions` : `the footprint of ${configs.map((c) => c.id).join(', ')}`);

log('places');
const allPlaces = await loadPlaces();
log(`  ${allPlaces.length} places nationally`);

interface Planned { meta: RouteMeta; line: XY[]; regions: string[]; via: string[] }
const planned = new Map<string, Planned>();

log('official routes (Wanderland Schweiz), whole');
const official = await loadWanderland();
const abroad: string[] = [];
/** Routes neither of whose ends resolves to a place, which keep the direction they were chained in. */
const unoriented: string[] = [];
for (const r of official) {
  if (excluded.has(r.id) || r.line.length < 2) continue;
  const id = `sm-${r.id}`, bb = bounds(r.line);
  // A region lists a route with enough of it inside its box.
  const regions = configs.filter((cfg) => {
    if (bb[0] > cfg.bbox[2] || bb[2] < cfg.bbox[0] || bb[1] > cfg.bbox[3] || bb[3] < cfg.bbox[1]) return false;
    const { piece, insideShare } = clipRoute(r.line, cfg.bbox);
    return insideShare >= cfg.minInside && polylineLength(piece) / 1000 >= cfg.minInsideKm;
  }).map((cfg) => cfg.id);
  if (!national && !regions.length) continue;
  const swiss = swissShare(r.line);
  if (swiss < MIN_SWISS) { abroad.push(`${r.id} ${r.name} (${Math.round(swiss * 100)} % in Switzerland)`); continue; }
  // Orient along the title: the start should be nearer "from" and the end nearer "to", both
  // resolved near the route; where only one resolves, it decides alone.
  const mid = centre(bb);
  let from = resolveRouteEnd(allPlaces, r.from, mid), to = resolveRouteEnd(allPlaces, r.to, mid);
  // "Crans-Montana, Cry-d'Er" and "Crans-Montana, Aminona" both find Crans-Montana: then the parts
  // after the comma tell the ends apart.
  if (from && to && from.id === to.id && r.from !== r.to) {
    const last = (s: string) => s.split(',').pop()!.trim();
    from = resolveRouteEnd(allPlaces, last(r.from), mid) ?? from;
    to = resolveRouteEnd(allPlaces, last(r.to), mid) ?? to;
  }
  const head = r.line[0], tail = r.line[r.line.length - 1];
  const d = (q: Place, pt: XY) => Math.hypot(q.e - pt[0], q.n - pt[1]);
  const wrongWay = (from ? d(from, head) - d(from, tail) : 0) + (to ? d(to, tail) - d(to, head) : 0);
  const line = wrongWay > 0 ? [...r.line].reverse() : r.line;
  if (!from && !to && r.from !== r.to) unoriented.push(r.id);
  planned.set(id, { meta: { id, number: r.number, name: r.name, from: r.from, to: r.to, source: 'schweizmobil', category: r.category }, line, regions, via: [] });
  if (r.gaps > 50 || r.dropped) log(`  ${r.id} ${r.name}: ${r.gaps.toFixed(0)} m chain gaps${r.dropped ? `, ${(r.dropped / 1000).toFixed(1)} km beyond a step over ${MAX_GAP} m left out` : ''}`);
  // SchweizMobil's own length, rounded to the km, flags a stage chained wrong.
  const km = polylineLength(line) / 1000;
  if (Math.abs(km - r.distance) > Math.max(1, r.distance * 0.2)) log(`  ${r.id} ${r.name}: ${km.toFixed(1)} km chained, SchweizMobil says ${r.distance} km`);
}
log(`  ${planned.size} of ${official.length} routes, ${[...planned.values()].filter((p) => p.regions.length).length} of them listed by a region`);
if (abroad.length) log(`  left out, mostly abroad: ${abroad.join('; ')}`);
if (unoriented.length) log(`  not oriented, neither end found: ${unoriented.join(', ')}`);

log('curated hikes (routed on the trail graph)');
for (const cfg of configs) {
  if (!cfg.curated.length) continue;
  const places = allPlaces.filter((p) => inBox(p, cfg.bbox));
  const graph = new TrailGraph(await loadTrails(pad(cfg.bbox, CURATED_PAD)));
  const near = centre(cfg.bbox);
  for (const hike of cfg.curated) {
    const id = `c-${hike.id}`;
    if (planned.has(id)) throw new Error(`${cfg.id}: curated hike id ${hike.id} is already used`);
    const stops = hike.via.map((v) => {
      const p = resolvePlace(places, v.name, v.near ?? near, v.kind) ?? resolvePlace(places, v.name, v.near ?? near);
      if (!p) throw new Error(`${hike.id}: cannot resolve "${v.name}"`);
      const node = graph.nearestNode(p.e, p.n, 600);
      if (node < 0) throw new Error(`${hike.id}: "${v.name}" is not near a trail`);
      return { place: p, node };
    });
    let line: XY[] = [];
    for (let i = 1; i < stops.length; i++) {
      const leg = graph.route(stops[i - 1].node, stops[i].node);
      if (!leg) throw new Error(`${hike.id}: no trail between ${stops[i - 1].place.name} and ${stops[i].place.name}`);
      line = line.concat(i === 1 ? leg : leg.slice(1));
    }
    const [first, last] = [stops[0].place, stops[stops.length - 1].place];
    planned.set(id, {
      meta: { id, number: null, name: hike.name, from: first.name, to: last.name, source: 'curated', category: 'classic' },
      line, regions: [cfg.id], via: stops.map((s) => s.place.id),
    });
  }
}

// Every tile with Swiss ground (nationally), and every tile a region or a route window touches: the
// route's own, and the one joined with each region that lists it.
const scope = new Set<string>();
const byId = new Map(configs.map((c) => [c.id, c]));
const cover = (b: BBox) => { for (const [e, n] of tilesCovering(b)) scope.add(tileKey(e, n)); };
if (national) for (const [e, n] of tilesCovering(CH_BBOX)) if (swissGround(e, n)) scope.add(tileKey(e, n));
for (const cfg of configs) cover(cfg.bbox);
for (const p of planned.values()) {
  cover(routeWindow(bounds(p.line)));
  for (const rid of p.regions) cover(routeWindow(bounds(p.line), byId.get(rid)!.bbox));
}
const keys = [...scope].sort();
log(`footprint: ${keys.length} tiles (${(keys.length * (TILE / 1000) ** 2).toLocaleString('en')} km²), ${planned.size} routes`);
if (dryRun) process.exit(0);

const corner = (key: string): [number, number] => key.split('_').map((v) => +v * 1000) as [number, number];

log(`terrain: ${keys.length} tiles of ${TILE_CELLS}×${TILE_CELLS} at ${CELL} m`);
const heights = new Map<string, Uint16Array>();
await mapLimit(keys, 4, async (key) => {
  const grid = await buildTerrain(tileBox(...corner(key)), CELL, true);
  heights.set(key, encodeU16(grid.data));
}, 'terrain tiles', 100);

log('trails');
const trails = new Map<string, { count: number; bytes: Uint8Array }>();
for (const key of keys) {
  const box = tileBox(...corner(key));
  const tileLines = await loadTrails(box, true);
  trails.set(key, { count: tileLines.length, bytes: encodeTrails(trailsData(tileLines, box, TRAIL_BIAS)) });
}

log('places');
const placesByTile = new Map<string, Place[]>();
for (const p of allPlaces) {
  const key = tileKey(...tileOf(p.e, p.n));
  if (!scope.has(key)) continue;
  if (!(p.alt > 0)) {
    const h = sampleTiles(heights, p.e, p.n);
    if (!Number.isNaN(h)) p.alt = Math.round(h);
  }
  (placesByTile.get(key) ?? placesByTile.set(key, []).get(key)!).push(p);
}

// A tile with no terrain, trails or places (all abroad) is left out; stitching leaves it empty.
const tiles = keys.filter((key) => heights.get(key)!.some((v) => v) || trails.get(key)!.count > 0 || placesByTile.has(key));
for (const key of tiles) {
  write(`terrain/${key}.bin`, encodeGrid(heights.get(key)!, TILE_CELLS));
  write(`trails/${key}.bin`, trails.get(key)!.bytes);
  write(`places/${key}.json`, lines((placesByTile.get(key) ?? []).map(roundPlace), '[', ']'));
}
log(`  ${tiles.length} tiles kept, ${keys.length - tiles.length} empty`);

log('routes');
const entries: CatalogueEntry[] = [];
for (const id of [...planned.keys()].sort()) {
  const p = planned.get(id)!;
  const bb = bounds(p.line);
  const places = allPlaces.filter((q) => inBox(q, bb, PLACE_PAD));
  const segments = new SegmentIndex(await loadTrails(pad(bb, 50)));
  const s = await finishRoute(p.meta, p.line, { places, segments, heightAt: (e, n) => sampleTiles(heights, e, n) }, p.via);
  const named = new Set(s.waypoints.map((w) => w.place));
  const meta = p.meta;
  const route: AtlasRoute = {
    ...meta,
    step: STEP,
    e: s.pts.map(([e]) => round1(e)),
    n: s.pts.map(([, n]) => round1(n)),
    alt: s.alt.map(round1),
    cls: s.cls,
    surf: s.surf,
    stats: s.stats,
    waypoints: s.waypoints,
    places: places.filter((q) => named.has(q.id)).map(roundPlace),
  };
  write(`routes/${id}.bin`, encodeRoute(route));
  const sb = bounds(s.pts);
  entries.push({
    id, number: meta.number, name: meta.name, from: meta.from, to: meta.to, source: meta.source, category: meta.category, stats: s.stats,
    bbox: [Math.floor(sb[0]), Math.floor(sb[1]), Math.ceil(sb[2]), Math.ceil(sb[3])],
    spark: Array.from({ length: SPARK_POINTS }, (_, k) => Math.round(s.alt[Math.round((k * (s.alt.length - 1)) / (SPARK_POINTS - 1))])),
    regions: p.regions,
  });
  log(`  ${id} ${meta.name}: ${s.stats.km} km ↑${s.stats.up} ↓${s.stats.down} ${s.stats.time} min, ${s.waypoints.length} waypoints, in ${p.regions.join(', ')}`);
}
const catalogue: Catalogue = { format: ATLAS_FORMAT, routes: entries };
write('catalogue.json', `{"format":${catalogue.format},"routes":${lines(catalogue.routes, '[', ']').trimEnd()}}\n`);

log('regions');
const summaries: RegionSummary[] = [];
for (const cfg of configs) {
  // The network and terrain in the box itself, as the region browser lists them.
  const trailKm: [number, number, number] = [0, 0, 0];
  let hardKm = 0;
  for (const t of await loadTrails(cfg.bbox)) {
    const km = polylineLength(t.pts.map(([e, n]) => [e, n])) / 1000;
    trailKm[t.cls] += km;
    if (t.hard) hardKm += km;
  }
  let minAlt = Infinity, maxAlt = -Infinity;
  for (const v of stitchGrid(cfg.bbox, (key) => heights.get(key)).heights) if (v) { minAlt = Math.min(minAlt, v / 10); maxAlt = Math.max(maxAlt, v / 10); }
  summaries.push(summariseRegion(cfg, entries, { trailKm, hardKm, alt: [minAlt, maxAlt] }));
}
write('regions.json', formatIndex(regionIndex(summaries)));

log('Switzerland locator');
const { locator, heights: relief } = await buildLocator(2000);
write('switzerland.u16', encodeU16(relief));
write('locator.json', `${JSON.stringify({ file: 'switzerland.u16', ...locator })}\n`);

// Stale tiles and routes go; anything else in OUT is left alone.
for (const dir of ['terrain', 'trails', 'places', 'routes']) {
  if (!existsSync(`${OUT}/${dir}`)) continue;
  for (const f of readdirSync(`${OUT}/${dir}`)) {
    if (written.has(`${dir}/${f}`)) continue;
    rmSync(`${OUT}/${dir}/${f}`);
    changed = true;
  }
}

const manifest: AtlasManifest = { format: ATLAS_FORMAT, tile: TILE, cell: CELL, tiles, routes: entries.length, sources: SOURCES, generated: new Date().toISOString() };
// Unchanged data keeps its build time, so the rebuild leaves manifest.json byte-identical too.
const manifestFile = `${OUT}/manifest.json`;
const previous = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, 'utf8')) as AtlasManifest) : null;
const sameData = previous && JSON.stringify({ ...previous, generated: '' }) === JSON.stringify({ ...manifest, generated: '' });
if (!changed && sameData) manifest.generated = previous.generated;
write('manifest.json', `${JSON.stringify(manifest)}\n`);
log(`${changed ? 'wrote' : 'unchanged:'} ${OUT}: ${tiles.length} tiles, ${entries.length} routes`);

function bounds(pts: XY[]): BBox {
  let [minE, minN, maxE, maxN] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [e, n] of pts) { minE = Math.min(minE, e); minN = Math.min(minN, n); maxE = Math.max(maxE, e); maxN = Math.max(maxN, n); }
  return [minE, minN, maxE, maxN];
}

function centre(b: BBox): [number, number] { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }

/** The share of a line's length inside the national border. */
function swissShare(line: XY[]): number {
  let inside = 0, total = 0;
  for (let i = 1; i < line.length; i++) {
    const len = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    total += len;
    if (insideRings(border, (line[i][0] + line[i - 1][0]) / 2, (line[i][1] + line[i - 1][1]) / 2)) inside += len;
  }
  return total ? inside / total : 0;
}

/** Whether a tile has Swiss ground: any point of a 500 m grid over it lies inside the border. */
function swissGround(e: number, n: number): boolean {
  for (let y = 250; y < TILE; y += 500) for (let x = 250; x < TILE; x += 500) if (insideRings(border, e + x, n + y)) return true;
  return false;
}

function pad(b: BBox, m: number): BBox { return [b[0] - m, b[1] - m, b[2] + m, b[3] + m]; }

/** Places are stored to the whole metre. */
function roundPlace(p: Place): Place { return { ...p, e: Math.round(p.e), n: Math.round(p.n) }; }

/** A JSON array with one item per line, so a change to one item is a one-line diff. */
function lines(items: unknown[], open: string, close: string): string {
  return items.length ? `${open}\n${items.map((x) => JSON.stringify(x)).join(',\n')}\n${close}\n` : `${open}${close}\n`;
}
