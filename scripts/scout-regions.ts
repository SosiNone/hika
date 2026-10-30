/**
 * Finds good region boxes in Switzerland's open data: `npm run scout:regions`.
 *
 *   npm run scout:regions                        the best boxes that overlap no regions/*.json
 *   npm run scout:regions -- --at E,N[,E,N …]    the best box near E,N that keeps the other points inside
 *   npm run scout:regions -- --places <id|bbox>  huts, lifts, stops, lakes and summits in a box, for curated hikes
 *
 * --at can repeat, and each box avoids the ones before it. --size 24x19 sets the box in km (the
 * default keeps the windows a region opens within check-atlas's budget). Scoring is in scripts/lib/scout.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { BBox, Place, PlaceKind, RegionConfig } from '../src/data/types';
import { insideRings } from '../src/geo/track';
import { CH_BBOX, loadBoundaries } from './lib/locator';
import { inBox, loadPlaces } from './lib/names';
import { bestWindowAround, CellGrid, rankWindows, type Layer, type Window } from './lib/scout';
import { trailSketch } from './lib/trails';

const args = process.argv.slice(2);
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const numbers = (s: string) => s.split(',').map(Number);
const [wKm, hKm] = (values('--size')[0] ?? '24x19').split('x').map(Number);
const size: [number, number] = [wKm * 1000, hKm * 1000];
const configs = readdirSync('regions').filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`regions/${f}`, 'utf8')) as RegionConfig);
const places = await loadPlaces();

const placesFor = values('--places')[0];
if (placesFor) {
  const bbox = placesFor.includes(',') ? (numbers(placesFor) as BBox) : configs.find((c) => c.id === placesFor)?.bbox;
  if (!bbox) throw new Error(`no regions/${placesFor}.json`);
  listPlaces(bbox);
} else {
  const grid = await buildGrid();
  const anchors = values('--at');
  const avoid = configs.map((c) => c.bbox);
  if (!anchors.length) {
    console.log(`Best ${wKm} × ${hKm} km boxes that overlap none of ${configs.map((c) => c.id).join(', ')}:\n`);
    for (const w of rankWindows(grid, size, { avoid, count: 15 })) describe(w);
  }
  for (const anchor of anchors) {
    const [e, n, ...rest] = numbers(anchor);
    const include = Array.from({ length: rest.length / 2 }, (_, k) => [rest[2 * k], rest[2 * k + 1]] as [number, number]);
    const w = bestWindowAround(grid, [e, n], size, { include, avoid });
    if (!w) { console.log(`--at ${anchor}: no box fits without overlapping a region\n`); continue; }
    describe(w, `--at ${anchor}`);
    avoid.push(w.bbox);
  }
}

async function buildGrid(): Promise<CellGrid> {
  const grid = new CellGrid(CH_BBOX);
  const byClass: Layer[] = ['wander', 'berg', 'alpin'];
  for (const t of await trailSketch()) grid.add(byClass[t.cls], t.e, t.n, t.km);
  for (const p of places) {
    const layer = placeLayer(p);
    if (layer) grid.add(layer, p.e, p.n);
  }
  const { border } = await loadBoundaries();
  grid.fill('inside', (e, n) => (insideRings(border, e, n) ? 1 : 0));
  return grid;
}

/** Summits from "Gipfel" up and rail stops count; bus stops and small hills don't. */
function placeLayer(p: Place): Layer | null {
  const layers: Partial<Record<PlaceKind, Layer>> = { inn: 'hut', lake: 'lake', view: 'view', lift: 'lift' };
  if (p.kind === 'summit') return p.prio >= 60 ? 'summit' : null;
  if (p.kind === 'stop') return p.prio >= 45 ? 'rail' : null;
  return layers[p.kind] ?? null;
}

function describe(w: Window, label = '') {
  const t = w.totals, inside = places.filter((p) => inBox(p, w.bbox));
  const summits = inside.filter((p) => p.kind === 'summit' && p.prio >= 60).sort((a, b) => b.alt - a.alt).slice(0, 3).map((p) => `${p.name} ${p.alt}`);
  const towns = inside.filter((p) => p.kind === 'village').sort((a, b) => b.prio - a.prio).slice(0, 4).map((p) => p.name);
  console.log(`${label ? `${label}\n` : ''}${w.score.toFixed(0).padStart(5)}  [${w.bbox.join(', ')}]  ${(w.inside * 100).toFixed(0)} % in Switzerland`);
  console.log(`       trails ${t.wander.toFixed(0)} / ${t.berg.toFixed(0)} / ${t.alpin.toFixed(0)} km (W/B/A) · ${t.hut} huts · ${t.summit} summits · ${t.lake} lakes · ${t.lift} lifts · ${t.rail} rail stops`);
  console.log(`       ${summits.join(', ')} · ${towns.join(', ')}\n`);
}

function listPlaces(bbox: BBox) {
  const inside = places.filter((p) => inBox(p, bbox));
  const kinds: PlaceKind[] = ['inn', 'lift', 'stop', 'lake', 'summit', 'pass', 'view', 'water'];
  for (const kind of kinds) {
    const ps = inside
      .filter((p) => p.kind === kind && !(kind === 'summit' && p.prio < 60) && !(kind === 'stop' && p.prio < 45))
      .sort((a, b) => b.prio - a.prio || b.alt - a.alt);
    console.log(`${kind === 'stop' ? 'rail stops' : kind} (${ps.length}): ${ps.map((p) => `${p.name} ${p.alt}`).join(' | ')}\n`);
  }
}
