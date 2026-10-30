import { prefetchRegion, type Atlas, type Region } from '../data/load';
import type { CatalogueEntry, RegionSummary } from '../data/types';
import { formatDuration } from '../geo/hikingTime';
import type { TerrainView } from '../gl/terrain';
import { cameraCone, hitRegion, regionDetail, SwissMap, type Sway, type Target } from '../hud/switzerland';
import { chart, esc, num } from '../panels/common';
import { filterRegions, filterRoutes } from '../regions';

/** Route results shown at most; the count says how many more match. */
const MAX_ROUTES = 40;

/** The view-transition names the tile and the browser hand between them (styled in hud.css): the frame, and the map in it. */
const MORPH = 'region-browser', MORPH_MAP = 'region-browser-map';

/** Whether at least half of `el` is in the viewport. */
function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.right > 0 && r.left < innerWidth && Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) > r.height / 2;
}

/**
 * The region browser: a dialog with a large map of Switzerland, every region boxed and named, and a
 * filterable list of the regions with their facts. The filter also searches every route in the
 * atlas, listed below the regions. The map and the list share one active entry; hovering either or
 * moving with ↑ / ↓ in the filter sets it, and lingering on a region warms the cache. An active
 * route is pinned on the map. A click opens a region (`go`) or a route (`open`); on a touch screen
 * a tap on the map first picks the region, and a tap on its list entry (or the same box again)
 * opens it.
 *
 * It is the locator panel (G), `tile`, grown: the same title, and the same map at the same angle
 * (`sway`). A view transition grows the tile into the browser while the two cross-fade, with the
 * map moving on its own from the tile's body to the browser's map pane, and closing shrinks it
 * back. With the tile scrolled off screen it zooms in and out on its own. Without view transitions,
 * or under prefers-reduced-motion, it opens and closes at once.
 */
export function mountRegionBrowser(atlas: Atlas, region: Region, view: TerrainView, go: (id: string) => void, open: (routeId: string) => void, tile: HTMLElement, sway: Sway) {
  const current = region.summary.id, regions = atlas.regions, routes = [...atlas.catalogue.values()];
  const dialog = document.createElement('dialog');
  dialog.className = 'region-browser';
  dialog.setAttribute('aria-labelledby', 'rb-title rb-meta');
  dialog.innerHTML = `
    <div class="panel-head"><span class="slot">G</span><h2 id="rb-title">Switzerland</h2><span class="meta" id="rb-meta"></span><button class="btn icon" data-k="close" aria-label="Close"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg></button></div>
    <div class="rb-body">
      <div class="rb-map"></div>
      <div class="rb-side">
        <input class="rb-filter" type="search" role="combobox" aria-expanded="true" aria-controls="rb-list" aria-autocomplete="list" aria-label="Search regions by name, place or canton, and routes by name, number or place" placeholder="SEARCH · REGION, ROUTE, PLACE, CANTON" autocomplete="off" spellcheck="false">
        <div class="rb-empty" role="status" hidden>NOTHING MATCHES</div>
        <div class="rb-list" id="rb-list" role="listbox" aria-label="Regions and routes">${regions.map(item).join('')}<div class="rb-routes" role="group" aria-label="Routes"></div></div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const q = <T extends HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  const meta = q('.meta'), empty = q('.rb-empty'), filter = q<HTMLInputElement>('.rb-filter'), list = q('.rb-list'), close = q<HTMLButtonElement>('[data-k="close"]');
  const routeList = q('.rb-routes');
  /** Every option by key: a region's id, or `r:` and a route's id for the route results shown. */
  const items = new Map([...list.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => [el.dataset.key!, el]));
  const regionKeys = [...items.keys()];
  /** The route behind a key, or undefined for a region. */
  const routeOf = (key: string | null) => (key?.startsWith('r:') ? atlas.catalogue.get(key.slice(2)) : undefined);
  items.get(current)?.classList.add('current');
  items.get(current)?.querySelector('.rb-line')!.insertAdjacentHTML('beforeend', '<em>CURRENT</em>');
  const ch = chart(q('.rb-map'));
  const map = new SwissMap(atlas.locator, atlas.swiss, regions, current);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let matches = regions, matchIds: Set<string> | null = null, active: string | null = current, picked: string | null = null;
  let targets: Target[] = [], pointerType = 'mouse', dwell = 0, frame = 0;
  // `shown` is the state asked for, which a view transition reaches a frame or two later.
  let shown = false, named: HTMLElement[] = [], morphing: ViewTransition | null = null;

  /**
   * Gives the transition's names to `el` (the tile or the dialog) alone, and with `withMap` the map
   * name to its map: two elements holding a name would abort the transition.
   */
  const name = (el: HTMLElement | null, withMap: boolean) => {
    for (const n of named) n.style.viewTransitionName = '';
    const map = withMap ? el?.querySelector<HTMLElement>('canvas.fill') : null;
    named = [el, map].filter((n): n is HTMLElement => !!n);
    if (el) el.style.viewTransitionName = MORPH;
    if (map) map.style.viewTransitionName = MORPH_MAP;
  };
  /**
   * Runs `update` (open or close) as a view transition in which `from` becomes `to`. When both are
   * there, their maps morph on their own; with one alone, it zooms as one picture.
   */
  const morph = (from: HTMLElement | null, to: HTMLElement | null, update: () => void) => {
    if (still || !document.startViewTransition) { update(); return; }
    const withMap = !!from && !!to;
    name(from, withMap);
    const vt = document.startViewTransition(() => { update(); name(to, withMap); });
    morphing = vt;
    // A newer transition skips this one and takes the names over.
    const done = () => { if (morphing === vt) { name(null, false); morphing = null; } };
    vt.finished.then(done, done);
  };
  /** The tile to grow from or shrink back into, while it is on screen. */
  const anchor = () => (onScreen(tile) ? tile : null);

  /** Closes the browser, shrinking it back into the tile. */
  const shut = () => {
    if (!shown) return;
    shown = false;
    morph(dialog, anchor(), () => dialog.close());
  };
  /** Opens a region (the current one just closes the browser) or a route. */
  const choose = (key: string) => {
    const r = routeOf(key);
    if (r) { shut(); open(r.id); } else if (key === current) shut(); else go(key);
  };
  const setActive = (id: string | null, scroll = false) => {
    if (id === active) return;
    if (active) items.get(active)?.setAttribute('aria-selected', 'false');
    active = id;
    clearTimeout(dwell);
    if (!id) { filter.removeAttribute('aria-activedescendant'); return; }
    const el = items.get(id)!;
    el.setAttribute('aria-selected', 'true');
    filter.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
    // Lingering warms the cache for the region, or for the first region that lists the route.
    const warm = routeOf(id)?.regions[0] ?? (id.startsWith('r:') ? null : id);
    if (warm && warm !== current) dwell = window.setTimeout(() => prefetchRegion(atlas, warm), 200);
  };
  /** The options shown, in list order. */
  const shownKeys = () => [...list.querySelectorAll<HTMLElement>('[role="option"]:not([hidden])')].map((el) => el.dataset.key!);
  const applyFilter = () => {
    matches = filterRegions(regions, filter.value);
    const keep = new Set(matches.map((r) => r.id));
    matchIds = matches.length === regions.length ? null : keep;
    for (const id of regionKeys) items.get(id)!.hidden = !keep.has(id);
    // Routes, once the filter has two characters: the first MAX_ROUTES, and how many match.
    for (const key of [...items.keys()]) if (key.startsWith('r:')) items.delete(key);
    const found = filter.value.trim().length >= 2 ? filterRoutes(routes, filter.value) : [];
    routeList.innerHTML = found.length ? `<div class="rb-group">ROUTES · ${found.length > MAX_ROUTES ? `${MAX_ROUTES} OF ` : ''}${found.length}</div>${found.slice(0, MAX_ROUTES).map((r) => routeItem(r, atlas)).join('')}` : '';
    for (const el of routeList.querySelectorAll<HTMLElement>('[role="option"]')) items.set(el.dataset.key!, el);
    // The active route's option was rebuilt: mark it again.
    if (active) items.get(active)?.setAttribute('aria-selected', 'true');
    empty.hidden = matches.length > 0 || found.length > 0;
    const regionsMeta = matches.length === regions.length ? `${regions.length} REGIONS` : `${matches.length} / ${regions.length} REGIONS`;
    meta.textContent = found.length ? `${regionsMeta} · ${found.length} ROUTES` : regionsMeta;
    const shown = shownKeys();
    if (!active || !shown.includes(active)) setActive(shown[0] ?? null, true);
    if (picked && !keep.has(picked)) picked = null;
  };

  // The list: hover sets the active region (with a mouse), a click or tap opens it.
  list.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const key = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]')?.dataset.key;
    if (key) setActive(key);
  });
  list.addEventListener('click', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]')?.dataset.key;
    if (key) choose(key);
  });
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (e) => {
    const shown = shownKeys(), k = active ? shown.indexOf(active) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = shown[Math.max(0, Math.min(shown.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) setActive(next, true);
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      choose(active);
    }
  });

  // The map: hover sets the active region; a click opens it, a tap picks it first.
  const at = (e: MouseEvent) => {
    const r = ch.canvas.getBoundingClientRect();
    return hitRegion(targets, e.clientX - r.left, e.clientY - r.top, pointerType === 'mouse' ? 6 : 12);
  };
  ch.canvas.addEventListener('pointerdown', (e) => { pointerType = e.pointerType; });
  ch.canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = at(e);
    ch.canvas.style.cursor = r ? 'pointer' : '';
    if (r) setActive(r.id, true);
  });
  ch.canvas.addEventListener('click', (e) => {
    const r = at(e);
    if (!r) { picked = null; return; }
    if (pointerType === 'mouse' || r.id === picked) choose(r.id);
    else {
      picked = r.id;
      setActive(r.id, true);
      if (r.id !== current) prefetchRegion(atlas, r.id);
    }
  });

  close.onclick = shut;
  // A click on the backdrop closes the dialog: it lands on the dialog element, outside its box.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) shut();
  });
  // Escape shrinks it back too, unless the browser won't let the page hold the close (then it just closes).
  dialog.addEventListener('cancel', (e) => {
    if (!e.cancelable) return;
    e.preventDefault();
    shut();
  });
  dialog.addEventListener('close', () => {
    shown = false;
    cancelAnimationFrame(frame);
    frame = 0;
    // The tile held its angle behind the browser; from there it sways on.
    sway.held = false;
  });
  // Back from the next region may restore this page from the bfcache with the browser still open.
  window.addEventListener('pageshow', () => { if (dialog.open) dialog.close(); });

  const draw = (now: number) => {
    const { w, h } = ch.begin(), route = routeOf(active);
    targets = map.draw(ch.ctx, w, h, {
      theta: still ? 0 : sway.theta,
      labels: 'all',
      // An active route lights up the region that lists it (if any), and is pinned at its middle.
      hover: route ? route.regions[0] ?? null : active,
      mark: route ? [(route.bbox[0] + route.bbox[2]) / 2, (route.bbox[1] + route.bbox[3]) / 2] : null,
      selected: picked,
      pulse: still ? undefined : now / 1000,
      cone: cameraCone(view),
      detail: regionDetail,
      match: matchIds,
    });
    frame = requestAnimationFrame(draw);
  };

  return {
    open() {
      if (shown) return;
      shown = true;
      morph(anchor(), dialog, () => {
        // The tile holds its angle behind the browser, which draws the map at it.
        sway.held = true;
        filter.value = '';
        picked = null;
        // A finger gets the list, not a keyboard popping up over it.
        const fine = matchMedia('(pointer: fine)').matches;
        filter.autofocus = fine;
        close.autofocus = !fine;
        dialog.showModal();
        applyFilter();
        setActive(null);
        setActive(current, true);
        // Drawn now, so the transition's picture of the browser already has the map.
        draw(performance.now());
        // The rows tick in one after another, like the log.
        if (!still) [...items.values()].forEach((el, k) => el.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 120 + Math.min(k, 12) * 20, easing: 'ease-out', fill: 'backwards' }));
      });
    },
  };
}

/** One region in the list: name, cantons, places, route counts, altitude range and the trail classes. */
function item(r: RegionSummary): string {
  const [w, b, a] = r.trailKm, total = w + b + a;
  const bar = [['wander', w], ['berg', b], ['alpin', a]].map(([c, km]) => `<i style="flex:${km};background:var(--${c})"></i>`).join('');
  return `<div class="rb-item" role="option" id="rb-${esc(r.id)}" data-key="${esc(r.id)}" aria-selected="false">
    <div class="rb-line"><b>${esc(r.title.toUpperCase())}</b><span>${esc(r.cantons.join(' / '))}</span></div>
    <div class="rb-sub">${esc(r.subtitle)}</div>
    <div class="rb-facts"><span>${r.routes} ROUTES${r.classics ? ` · ${r.classics} CLASSICS` : ''} · ${num(total)} KM</span><span>${num(r.alt[0])}–${num(r.alt[1])} M</span></div>
    <div class="rb-classes" title="Trails: ${num(w)} km Wanderweg · ${num(b)} km Bergwanderweg · ${num(a)} km Alpinwanderweg">${bar}</div>
  </div>`;
}

/** One route in the search results: number, name, the region that lists it, its ends and its length. */
function routeItem(r: CatalogueEntry, atlas: Atlas): string {
  const where = atlas.regions.find((g) => g.id === r.regions[0])?.title ?? 'NO REGION';
  return `<div class="rb-item rb-route" role="option" id="rb-r-${esc(r.id)}" data-key="r:${esc(r.id)}" aria-selected="false">
    <div class="rb-line"><b>${esc(r.number ?? '★')} · ${esc(r.name.toUpperCase())}</b><span>${esc(where.toUpperCase())}</span></div>
    <div class="rb-sub">${esc(r.from)} → ${esc(r.to)}</div>
    <div class="rb-facts"><span>${r.stats.km.toFixed(1)} KM · ↑${num(r.stats.up)} ↓${num(r.stats.down)} · ${formatDuration(r.stats.time, true)}</span><span>${r.category.toUpperCase()}</span></div>
  </div>`;
}
