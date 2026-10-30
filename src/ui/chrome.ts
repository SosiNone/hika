import type { Region, RouteView } from '../data/load';
import type { RegionSummary } from '../data/types';
import { lv95ToWgs84 } from '../geo/lv95';
import { esc, num } from '../panels/common';
import type { Store } from '../state';
import { isScheme, type Scheme } from '../theme/tokens';

const REPO = 'https://github.com/SosiNone/hika';

/** Footer version link: the release tag in builds, the repository in the dev server. */
export function showVersion(el: HTMLAnchorElement) {
  const tag = `v${__APP_VERSION__}`;
  el.textContent = import.meta.env.DEV ? `${tag}-DEV` : tag;
  el.href = import.meta.env.DEV ? REPO : `${REPO}/releases/tag/${tag}`;
  el.title = 'HIKA version';
}

/**
 * The brand's subtitle line, "ALPSTEIN · AI / AR / SG": once there is more than one region, a
 * button that opens the region browser.
 */
export function mountRegionPicker(el: HTMLElement, regions: RegionSummary[], current: RegionSummary, open: () => void) {
  const label = `${current.title.toUpperCase()} · ${current.cantons.join(' / ')}`;
  el.title = current.subtitle;
  if (regions.length < 2) {
    el.textContent = label;
    return;
  }
  el.innerHTML = `<button class="region-pick" aria-haspopup="dialog" title="${esc(current.subtitle)} · all regions (G)">${esc(label)}</button>`;
  el.querySelector('button')!.onclick = open;
}

/** Footer dark / light switch; the store owns the choice, main.ts applies it. */
export function mountDisplaySwitch(el: HTMLElement, store: Store) {
  const schemes: Scheme[] = ['dark', 'light'];
  el.innerHTML = `<div class="seg" role="group" aria-label="Colour scheme">${schemes.map((s) => `<button data-scheme="${s}">${s.toUpperCase()}</button>`).join('')}</div>`;
  const sync = () => {
    el.querySelectorAll<HTMLButtonElement>('[data-scheme]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scheme === store.state.display.scheme)));
  };
  el.addEventListener('click', (e) => {
    const scheme = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-scheme]')?.dataset.scheme;
    if (isScheme(scheme) && scheme !== store.state.display.scheme) store.set({ display: { scheme } });
  });
  store.subscribe((s, prev) => { if (s.display !== prev.display) sync(); });
  sync();
}

/** Top-bar clock (Swiss local time) with today's sunrise / sunset over the region. */
export function startClock(region: Region) {
  const date = document.getElementById('clock-date')!, time = document.getElementById('clock-time')!, sun = document.getElementById('clock-sun')!;
  const bb = region.summary.bbox;
  const [lon, lat] = lv95ToWgs84((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
  const tz = 'Europe/Zurich';
  const fmtTime = new Intl.DateTimeFormat('de-CH', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtShort = new Intl.DateTimeFormat('de-CH', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const tick = () => {
    const now = new Date();
    time.textContent = fmtTime.format(now);
    date.textContent = `${fmtDate.format(now)} · ZÜRICH`;
    const { rise, set } = sunTimes(now, lat, lon);
    sun.textContent = rise && set ? `SUN ↑${fmtShort.format(rise)} ↓${fmtShort.format(set)}` : '';
  };
  tick();
  setInterval(tick, 1000);
}

/** NOAA sunrise equation (±1 min), good enough for a status line. */
export function sunTimes(day: Date, lat: number, lon: number): { rise: Date | null; set: Date | null } {
  const rad = Math.PI / 180;
  const n = Math.floor(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 86400000 - 10957.5) + 0.0008;
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
  const decl = Math.asin(Math.sin(lambda * rad) * Math.sin(23.44 * rad));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (Math.abs(cosW) > 1) return { rise: null, set: null };
  const w = Math.acos(cosW) / rad / 360;
  const toDate = (jd: number) => new Date((jd - 2440587.5) * 86400000);
  return { rise: toDate(transit - w), set: toDate(transit + w) };
}

/** Top ticker: the route at a glance; footer ticker: waypoint altitudes, scrolling. */
export function renderTickers(region: Region, r: RouteView, ids: Map<string, string>) {
  const top = document.getElementById('top-ticker')!, foot = document.getElementById('foot-ticker')!;
  const s = r.stats;
  top.innerHTML = [
    `<b>${r.number ? `ROUTE ${r.number}` : '★ CLASSIC'}</b> ${esc(r.name.toUpperCase())}`,
    `${esc(r.from.toUpperCase())} → ${esc(r.to.toUpperCase())}`,
    `<b>${s.km.toFixed(1)}</b> KM`, `<b>↑${num(s.up)}</b> M`, `<b>↓${num(s.down)}</b> M`,
    `<b>${Math.floor(s.time / 60)}:${String(s.time % 60).padStart(2, '0')}</b> H · BACK ${Math.floor(s.timeBack / 60)}:${String(s.timeBack % 60).padStart(2, '0')} H`,
  ].map((x) => `<span>${x}</span>`).join('');
  const items = r.waypoints.map((w) => `<span><i>${ids.get(w.place)}</i>${esc((region.places.get(w.place)?.name ?? '').toUpperCase())} ${w.alt}</span>`).join('');
  foot.innerHTML = `<span class="track">${items}${items}</span>`;
}
