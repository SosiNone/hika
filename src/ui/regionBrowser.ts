import { prefetchRegion, type Region } from '../data/load';
import type { RegionSummary } from '../data/types';
import type { TerrainView } from '../gl/terrain';
import { cameraCone, hitRegion, regionDetail, SwissMap, type Target } from '../hud/switzerland';
import { chart, esc, num } from '../panels/common';
import { filterRegions } from '../regions';

/**
 * The region browser: a dialog with a large map of Switzerland, every region boxed and named, and a
 * filterable list of the regions with their facts. The map and the list share one active region;
 * hovering either or moving with ↑ / ↓ in the filter sets it, and lingering on it warms the cache.
 * A click opens a region (`go`); on a touch screen a tap on the map first picks the region, and a
 * tap on its list entry (or the same box again) opens it.
 */
export function mountRegionBrowser(region: Region, regions: RegionSummary[], view: TerrainView, go: (id: string) => void) {
  const current = region.bundle.id;
  const dialog = document.createElement('dialog');
  dialog.className = 'region-browser';
  dialog.setAttribute('aria-labelledby', 'rb-title');
  dialog.innerHTML = `
    <div class="panel-head"><span class="slot">G</span><h2 id="rb-title">Regions</h2><span class="meta"></span><button class="btn icon" data-k="close" aria-label="Close"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg></button></div>
    <div class="rb-body">
      <div class="rb-map"></div>
      <div class="rb-side">
        <input class="rb-filter" type="search" role="combobox" aria-expanded="true" aria-controls="rb-list" aria-autocomplete="list" aria-label="Filter regions by name, place or canton" placeholder="FILTER · NAME, PLACE, CANTON" autocomplete="off" spellcheck="false">
        <div class="rb-empty" role="status" hidden>NO REGION MATCHES</div>
        <div class="rb-list" id="rb-list" role="listbox" aria-label="Regions">${regions.map(item).join('')}</div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const q = <T extends HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  const meta = q('.meta'), empty = q('.rb-empty'), filter = q<HTMLInputElement>('.rb-filter'), list = q('.rb-list'), close = q<HTMLButtonElement>('[data-k="close"]');
  const items = new Map([...list.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => [el.dataset.id!, el]));
  items.get(current)?.classList.add('current');
  items.get(current)?.querySelector('.rb-line')!.insertAdjacentHTML('beforeend', '<em>CURRENT</em>');
  const ch = chart(q('.rb-map'));
  const map = new SwissMap(region.bundle.locator, region.swiss, regions, current);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let matches = regions, matchIds: Set<string> | null = null, active: string | null = current, picked: string | null = null;
  let targets: Target[] = [], pointerType = 'mouse', dwell = 0, frame = 0;

  /** Opens a region; the current one just closes the browser. */
  const choose = (id: string) => (id === current ? dialog.close() : go(id));
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
    if (id !== current) dwell = window.setTimeout(() => prefetchRegion(id), 200);
  };
  const applyFilter = () => {
    matches = filterRegions(regions, filter.value);
    const keep = new Set(matches.map((r) => r.id));
    matchIds = matches.length === regions.length ? null : keep;
    for (const [id, el] of items) el.hidden = !keep.has(id);
    empty.hidden = matches.length > 0;
    meta.textContent = matches.length === regions.length ? `${regions.length} REGIONS` : `${matches.length} / ${regions.length} REGIONS`;
    if (!active || !keep.has(active)) setActive(matches[0]?.id ?? null, true);
    if (picked && !keep.has(picked)) picked = null;
  };

  // The list: hover sets the active region (with a mouse), a click or tap opens it.
  list.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const id = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]')?.dataset.id;
    if (id) setActive(id);
  });
  list.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]')?.dataset.id;
    if (id) choose(id);
  });
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (e) => {
    const k = matches.findIndex((r) => r.id === active);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = matches[Math.max(0, Math.min(matches.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) setActive(next.id, true);
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
      if (r.id !== current) prefetchRegion(r.id);
    }
  });

  close.onclick = () => dialog.close();
  // A click on the backdrop closes the dialog: it lands on the dialog element, outside its box.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { cancelAnimationFrame(frame); frame = 0; });
  // Back from the next region may restore this page from the bfcache with the browser still open.
  window.addEventListener('pageshow', () => { if (dialog.open) dialog.close(); });

  const draw = (now: number) => {
    const { w, h } = ch.begin();
    targets = map.draw(ch.ctx, w, h, {
      tilt: 0.7,
      labels: 'all',
      hover: active,
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
      if (dialog.open) return;
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
      frame = requestAnimationFrame(draw);
    },
  };
}

/** One region in the list: name, cantons, places, route counts, altitude range and the trail classes. */
function item(r: RegionSummary): string {
  const [w, b, a] = r.trailKm, total = w + b + a;
  const bar = [['wander', w], ['berg', b], ['alpin', a]].map(([c, km]) => `<i style="flex:${km};background:var(--${c})"></i>`).join('');
  return `<div class="rb-item" role="option" id="rb-${esc(r.id)}" data-id="${esc(r.id)}" aria-selected="false">
    <div class="rb-line"><b>${esc(r.title.toUpperCase())}</b><span>${esc(r.cantons.join(' / '))}</span></div>
    <div class="rb-sub">${esc(r.subtitle)}</div>
    <div class="rb-facts"><span>${r.routes} ROUTES${r.classics ? ` · ${r.classics} CLASSICS` : ''} · ${num(total)} KM</span><span>${num(r.alt[0])}–${num(r.alt[1])} M</span></div>
    <div class="rb-classes" title="Trails: ${num(w)} km Wanderweg · ${num(b)} km Bergwanderweg · ${num(a)} km Alpinwanderweg">${bar}</div>
  </div>`;
}
