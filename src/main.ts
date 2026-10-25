import './styles/hud.css';
import { indexAtMinute, loadRegion, type Region, type RouteView } from './data/load';
import { project } from './gl/glkit';
import { TerrainView, type TrailMode } from './gl/terrain';
import { LabelLayer } from './hud/labels';
import { mountCumulative, mountGradient, mountProfile } from './panels/charts';
import type { Ctx } from './panels/common';
import { mountReplay, mountRoutes, mountTrailClass, mountWaypoints } from './panels/left';
import { mountLocator, mountLog, mountTerrainStats } from './panels/right';
import { Store } from './state';
import { applyDisplay, loadDisplay, palette, saveDisplay } from './theme/apply';
import { mountDisplaySwitch, renderTickers, showVersion, startClock } from './ui/chrome';

const DEFAULT_ROUTE = 'c-saentis-lisengrat';

// Before the region loads, so the boot screen already wears the chosen scheme.
const initialDisplay = loadDisplay();
applyDisplay(initialDisplay);
showVersion(document.getElementById('version') as HTMLAnchorElement);

async function boot() {
  const bootEl = document.getElementById('boot')!;
  try {
    const region = await loadRegion('alpstein');
    start(region);
    bootEl.classList.add('done');
    setTimeout(() => bootEl.remove(), 700);
  } catch (err) {
    bootEl.classList.add('error');
    bootEl.textContent = `Could not start: ${(err as Error).message}`;
    throw err;
  }
}

function start(region: Region) {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('route');
  const store = new Store({
    routeId: region.routes.some((r) => r.id === fromHash) ? fromHash! : region.routes.find((r) => r.id === DEFAULT_ROUTE)?.id ?? region.routes[0].id,
    hoverRouteId: null,
    hoverIndex: null,
    minute: 0,
    playing: true,
    secondsPerHour: 3,
    mode: 'mono',
    display: initialDisplay,
  });
  const byId = new Map(region.routes.map((r) => [r.id, r]));
  const route = () => byId.get(store.state.routeId)!;
  let ids = waypointIds(route());

  const canvas = document.getElementById('terrain') as HTMLCanvasElement;
  const view = new TerrainView(canvas, region);
  view.palette = palette.gl;
  const labels = new LabelLayer(document.getElementById('terrain-hud') as HTMLCanvasElement, region, view);
  const ctx: Ctx = { region, store, view, route, hikerIndex: () => indexAtMinute(route(), store.state.minute), waypointIds: () => ids };
  document.getElementById('brand-sub')!.textContent = `${region.bundle.title.toUpperCase()} · ${region.bundle.cantons.join(' / ')}`;
  const overlay = mountStageOverlay(region, store, view);

  const panels = [
    mountReplay(document.getElementById('p-replay')!, ctx),
    mountWaypoints(document.getElementById('p-waypoints')!, ctx),
    mountTrailClass(document.getElementById('p-class')!, ctx),
    mountRoutes(document.getElementById('p-routes')!, ctx),
    mountProfile(document.getElementById('p-profile')!, ctx),
    mountGradient(document.getElementById('p-gradient')!, ctx),
    mountLocator(document.getElementById('p-locator')!, ctx),
    mountCumulative(document.getElementById('p-cumulative')!, ctx),
    mountTerrainStats(document.getElementById('p-terrainstats')!, ctx),
    mountLog(document.getElementById('p-log')!, ctx),
  ];

  const selectRoute = (r: RouteView) => {
    ids = waypointIds(r);
    view.setRoute(r);
    renderTickers(region, r, ids);
    flyToRoute(view, r);
    history.replaceState(null, '', `#route=${r.id}`);
  };
  selectRoute(route());
  store.subscribe((s, prev) => {
    if (s.routeId !== prev.routeId) selectRoute(route());
    if (s.hoverRouteId !== prev.hoverRouteId) view.setHover(s.hoverRouteId && s.hoverRouteId !== s.routeId ? byId.get(s.hoverRouteId)! : null);
    if (s.mode !== prev.mode) view.mode = s.mode === 'natural' ? 1 : 0;
    if (s.display !== prev.display) {
      applyDisplay(s.display);
      saveDisplay(s.display);
      view.palette = palette.gl;
    }
  });

  // Click (not drag) on the map selects the nearest route under the cursor.
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const rect = canvas.getBoundingClientRect();
    const hit = pickRoute(region, view, lastVp, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    if (hit && hit !== store.state.routeId) store.set({ routeId: hit, minute: 0, playing: true });
  });
  view.camera.attach(canvas, () => {});
  window.addEventListener('hashchange', () => {
    const id = new URLSearchParams(location.hash.slice(1)).get('route');
    if (id && byId.has(id) && id !== store.state.routeId) store.set({ routeId: id, minute: 0, playing: true });
  });

  startClock(region);
  mountDisplaySwitch(document.getElementById('display')!, store);

  let last = performance.now(), lastPanels = 0, holdUntil = 0;
  let lastVp = view.camera.viewProj(1);
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    const s = store.state, r = route();
    const total = r.minutes[r.minutes.length - 1];
    if (s.playing) {
      // Advance silently (panels poll the state); hold 2.5 s at the finish, then loop.
      if (s.minute < total) store.state.minute = Math.min(total, s.minute + (dt * 60) / s.secondsPerHour);
      else if (!holdUntil) holdUntil = now + 2500;
      else if (now > holdUntil) { store.state.minute = 0; holdUntil = 0; }
    }
    const hiker = indexAtMinute(r, store.state.minute);
    view.doneMetres = hiker * r.step;
    const info = view.render(t, dt);
    lastVp = info.vp;
    labels.draw(info, r, hiker, store.state.hoverIndex, ids);
    overlay(info, r, hiker);
    if (now - lastPanels > 50) {
      lastPanels = now;
      for (const p of panels) p(t);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/** DEP, P1 … Pn, ARR for the waypoints of a route. */
function waypointIds(r: RouteView): Map<string, string> {
  const m = new Map<string, string>();
  r.waypoints.forEach((w, i) => m.set(w.place, i === 0 ? 'DEP' : i === r.waypoints.length - 1 ? 'ARR' : `P${i}`));
  return m;
}

function flyToRoute(view: TerrainView, r: RouteView) {
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, maxA = 0;
  for (let i = 0; i < r.e.length; i++) {
    minE = Math.min(minE, r.e[i]); maxE = Math.max(maxE, r.e[i]);
    minN = Math.min(minN, r.n[i]); maxN = Math.max(maxN, r.n[i]);
    maxA = Math.max(maxA, r.alt[i]);
  }
  const [x, , z] = view.world((minE + maxE) / 2, (minN + maxN) / 2, 0);
  const extent = Math.max(maxE - minE, maxN - minN, 3000);
  view.camera.flyTo({ target: [x, (maxA - view.base) * view.exaggeration * 0.45, z], dist: Math.min(42000, extent * 1.9 + 4000) });
}

function pickRoute(region: Region, view: TerrainView, vp: Float32Array, x: number, y: number, w: number, h: number): string | null {
  let best: string | null = null, bd = 14;
  for (const r of region.routes) {
    for (let i = 0; i < r.e.length; i += 3) {
      const [wx, wy, wz] = view.world(r.e[i], r.n[i], r.alt[i] + 6);
      const s = project(vp, wx, wy, wz, w, h);
      if (s.w <= 0) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = r.id; }
    }
  }
  return best;
}

/** Stage chrome inside the terrain panel: title, camera readout, toggles, status, LV95 column. */
function mountStageOverlay(region: Region, store: Store, view: TerrainView) {
  const stage = document.getElementById('p-terrain')!;
  const el = document.createElement('div');
  el.className = 'stage-overlay';
  el.innerHTML = `
    <div class="stage-head"><span class="slot">01</span><span>${region.bundle.title.toUpperCase()} — HIKING NETWORK</span></div>
    <div class="stage-readout" data-k="cam"></div>
    <div class="stage-toggles"><div class="seg" role="group" aria-label="Colour mode"><button data-mode="mono" aria-pressed="true">MONO</button><button data-mode="natural" aria-pressed="false">SWISSIMAGE</button></div>
      <button class="btn" data-k="vert" style="margin-left:6px">VERT ×1.5</button>
      <button class="btn" data-k="trails" style="margin-left:6px"></button></div>
    <div class="stage-route" data-k="route"></div>
    <div class="coords" data-k="coords"></div>
    <div class="stage-hints">DRAG · ORBIT &nbsp;&nbsp; RIGHT-DRAG · PAN &nbsp;&nbsp; WHEEL · ZOOM &nbsp;&nbsp; CLICK · SELECT ROUTE &nbsp;&nbsp; DBL-CLICK · RESET</div>
    <div class="stage-status" data-k="status"></div>`;
  stage.appendChild(el);
  const q = (k: string) => el.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
  el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.onclick = () => {
      store.set({ mode: b.dataset.mode as 'mono' | 'natural' });
      el.querySelectorAll('[data-mode]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    };
  });
  const exags = [1, 1.5, 2, 3];
  q('vert').onclick = () => {
    view.exaggeration = exags[(exags.indexOf(view.exaggeration) + 1) % exags.length];
    q('vert').textContent = `VERT ×${view.exaggeration}`;
  };
  const trailModes: [TrailMode, string][] = [
    ['auto', 'Trail network: shown when zoomed in'],
    ['all', 'Trail network: always shown'],
    ['off', 'Trail network: hidden, the selected route only'],
  ];
  const showTrailMode = () => {
    q('trails').textContent = `TRAILS ${view.trailMode.toUpperCase()}`;
    q('trails').title = trailModes.find(([m]) => m === view.trailMode)![1];
  };
  q('trails').onclick = () => {
    view.trailMode = trailModes[(trailModes.findIndex(([m]) => m === view.trailMode) + 1) % trailModes.length][0];
    showTrailMode();
  };
  showTrailMode();
  const { grid } = region.bundle;
  let lastIdx = -1;
  return (info: { focus: number; scanAlt: number; fps: number; points: number }, r: RouteView, hiker: number) => {
    const c = view.camera;
    const deg = (v: number) => ((((v * 180) / Math.PI) % 360) + 360) % 360;
    q('cam').textContent = `CAM AZ ${deg(c.az).toFixed(1).padStart(5)}°  EL ${deg(c.el).toFixed(1)}°  R ${(c.dist / 1000).toFixed(1)} KM\nFOCUS ${(info.focus / 1000).toFixed(1)} KM  VERT ×${view.exaggeration}  GRID ${grid.cell} M`;
    q('route').textContent = `${r.number ? `ROUTE ${r.number}` : '★ CLASSIC'} · ${r.name.toUpperCase()}`;
    q('status').textContent = `SCAN ALT ${Math.round(info.scanAlt)} M   H1 T+${Math.floor(r.minutes[hiker] / 60)}:${String(Math.floor(r.minutes[hiker] % 60)).padStart(2, '0')}\nPTS ${info.points.toLocaleString('en').replace(/,/g, ' ')}   ${Math.round(info.fps)} FPS`;
    if (hiker !== lastIdx) {
      lastIdx = hiker;
      const [e0, n0] = [region.bundle.bbox[0], region.bundle.bbox[1]];
      const rows: string[] = [];
      for (let k = -14; k <= 14; k++) {
        const i = Math.min(r.e.length - 1, Math.max(0, hiker + k * 4));
        const line = `${Math.round(e0 + r.e[i])} ${Math.round(n0 + r.n[i])} ${String(Math.round(r.alt[i])).padStart(4)} ${r.km[i].toFixed(1).padStart(4)}`;
        rows.push(k === 0 ? `<div class="now">▸ ${line}</div>` : `<div>${line}</div>`);
      }
      q('coords').innerHTML = rows.join('');
    }
  };
}

boot();
