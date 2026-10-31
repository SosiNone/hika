import type { RouteView } from '../data/load';
import { OFF_NETWORK, TRAIL_CLASSES, type RangeSummary } from '../data/types';
import { smoothAltitudes } from '../geo/hikingTime';
import { lv95ToWgs84 } from '../geo/lv95';
import { pointer } from '../hud/pointer';
import { cameraCone, hitTarget, rangeDetail, SwissMap, type Sway, type Target } from '../hud/switzerland';
import { chart, COLORS, esc, FONT, frame, hm, num, type Ctx } from './common';

/** Four corners, the "expand" glyph of the button that opens the region browser. */
const EXPAND_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 4.5V1h3.5M7.5 1H11v3.5M11 7.5V11H7.5M4.5 11H1V7.5"/></svg>';

/**
 * G · Switzerland locator: the national relief with lakes, the mountain ranges and the areas that
 * tile them (src/hud/switzerland.ts), the current area in the accent with the 3D camera's footprint.
 * It sways slowly (`sway`, shared with the region browser) but holds still under the pointer.
 * Hovering a range lights it up and names it, and a click opens the region browser zoomed into it;
 * on a touch screen the first tap names it and offers a button for that. The head button opens the
 * browser on the whole country.
 */
export function mountLocator(el: HTMLElement, c: Ctx, sway: Sway) {
  const { body, meta } = frame(el, 'G', 'Switzerland');
  body.style.height = '150px';
  body.style.flex = 'none';
  const ch = chart(body);
  const expand = document.createElement('button');
  expand.className = 'btn icon';
  expand.title = 'All areas (G)';
  expand.setAttribute('aria-label', 'All areas');
  expand.innerHTML = EXPAND_ICON;
  expand.onclick = () => c.openRegions();
  el.querySelector('.panel-head')!.appendChild(expand);
  const open = document.createElement('button');
  open.className = 'btn locator-open';
  open.hidden = true;
  body.appendChild(open);

  const map = new SwissMap(c.atlas.locator, c.atlas.swiss, c.atlas.index, c.region.summary.id);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [lon, lat] = lv95ToWgs84(...c.region.summary.label);
  const coords = `${lat.toFixed(2)}N ${lon.toFixed(2)}E`;
  const rangeById = new Map(c.atlas.ranges.map((g) => [g.id, g]));
  let targets: Target[] = [];
  let hover: string | null = null, selected: RangeSummary | null = null, over = false, pointerType = 'mouse';
  let last = 0;

  /** The range under the pointer, with a finger getting more slack. */
  const at = (e: PointerEvent | MouseEvent) => {
    const r = ch.canvas.getBoundingClientRect();
    const hit = hitTarget(targets, e.clientX - r.left, e.clientY - r.top, pointerType === 'mouse' ? 4 : 12);
    return hit ? rangeById.get(hit.id) ?? null : null;
  };
  const select = (g: RangeSummary | null) => {
    selected = g;
    open.hidden = !g;
    if (g) open.textContent = `EXPLORE ${g.title.toUpperCase()} ›`;
  };
  open.onclick = () => { if (selected) c.openRegions(selected.id); };
  ch.canvas.addEventListener('pointerdown', (e) => { pointerType = e.pointerType; });
  ch.canvas.addEventListener('pointermove', (e) => {
    over = true;
    if (e.pointerType !== 'mouse') return;
    const g = at(e);
    hover = g?.id ?? null;
    ch.canvas.style.cursor = g ? 'pointer' : '';
  });
  ch.canvas.addEventListener('pointerleave', () => { over = false; hover = null; });
  ch.canvas.addEventListener('click', (e) => {
    const g = at(e);
    if (pointerType === 'mouse') { if (g) c.openRegions(g.id); }
    else if (g && g.id === selected?.id) c.openRegions(g.id);
    else select(g);
  });

  return (t: number) => {
    const dt = last ? t - last : 0;
    last = t;
    // The sway stops while the pointer is over the map or a range is picked, so targets hold still.
    if (!still && !over && !selected) sway.step(dt);
    const { w, h } = ch.begin();
    targets = map.draw(ch.ctx, w, h, {
      theta: still ? 0 : sway.theta,
      labels: 'focus',
      hover,
      selected: selected?.id,
      pulse: still ? undefined : t,
      cone: cameraCone(c.view),
      detail: (tg) => rangeDetail(rangeById.get(tg.id)!),
    });
    const focus = rangeById.get((hover ?? selected?.id)!);
    meta.textContent = focus ? focus.names[0].toUpperCase() : coords;
  };
}

/** Track span (m) either side of the hiker for the walking direction on the rose, as on the map. */
const HEADING_SPAN = 60;
/** Time constant (s) of the rose's heading low-pass filter. */
const HEADING_TAU = 0.15;

/** The sun-facing aspect sectors (SE, S, SW), drawn in the accent on the rose. */
const SUNNY = new Set([3, 4, 5]);

/**
 * I · Terrain analysis along the route: slope classes, slope aspect and the altitude range, with
 * the part already walked by the preview hiker filled in and a cursor at where the hiker is now.
 */
export function mountTerrainStats(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'I', 'Terrain analysis');
  body.style.display = 'grid';
  // minmax(0, …): a long summit name must truncate, not widen the bars and push the rose out.
  body.style.gridTemplateColumns = 'minmax(0, 1fr) 92px';
  body.style.gap = '10px';
  const bars = document.createElement('div');
  bars.className = 'bars';
  const roseBox = document.createElement('div');
  roseBox.style.position = 'relative';
  roseBox.style.height = '92px';
  body.append(bars, roseBox);
  const rose = chart(roseBox);
  let built: RouteView | null = null;
  let a: Analysis;
  let rows: { row: HTMLElement; walked: HTMLElement; cursor: HTMLElement }[] = [];
  let altCursor: HTMLElement, altVal: HTMLElement;
  let max = 1;
  let heading: { angle: number; t: number } | null = null;
  return () => {
    const r = c.route(), i = Math.min(c.hikerIndex(), r.alt.length - 1);
    if (built !== r) {
      built = r;
      a = analyse(c, r);
      heading = null;
      const labels = ['0–10 %', '10–20 %', '20–30 %', '30–40 %', '> 40 %'];
      max = Math.max(...a.slope, 0.001);
      const fill = (k: number) => (k === 4 ? 'var(--berg)' : 'var(--text-2)');
      bars.innerHTML = a.slope.map((km, k) => `<div class="bar-row" style="grid-template-columns:62px 1fr 48px"><span>${labels[k]}</span><span class="track"><span class="fillbar total" style="width:${(km / max) * 100}%;background:${fill(k)}"></span><span class="fillbar" style="background:${fill(k)}"></span><span class="cursor"></span></span><span class="val">${km.toFixed(1)} KM</span></div>`).join('') +
        `<div class="bar-row alt-row" style="grid-template-columns:62px 1fr 48px"><span>ALTITUDE</span><span class="track"><span class="cursor"></span></span><span class="val"></span></div>` +
        `<div class="alt-range"><span>${num(r.stats.minAlt)} M</span><span title="${a.top ? esc(a.top) : ''}">${num(r.stats.maxAlt)} M${a.top ? ` · ${esc(a.top)}` : ''}</span></div>`;
      rows = [...bars.querySelectorAll<HTMLElement>('.bar-row:not(.alt-row)')].map((row) => ({ row, walked: row.querySelector('.fillbar:not(.total)')!, cursor: row.querySelector('.cursor')! }));
      altCursor = bars.querySelector('.alt-row .cursor')!;
      altVal = bars.querySelector('.alt-row .val')!;
    }

    // Slope bars: km walked per class so far, and the hiker's current class with a cursor at its
    // walked edge. The class comes from the slope over ~100 m, as per sample it would flicker.
    const grade = a.grade[i], now = Math.min(4, Math.floor(Math.abs(grade) / 10));
    rows.forEach(({ row, walked, cursor }, k) => {
      const width = `${(a.slopeCum[k][i] / max) * 100}%`;
      if (walked.style.width !== width) walked.style.width = cursor.style.left = width;
      row.classList.toggle('now', k === now);
    });
    meta.textContent = `NOW ${grade < 0 ? '−' : '+'}${Math.abs(grade).toFixed(0)} % · MAX ${a.maxSlope.toFixed(0)} %`;
    const span = Math.max(1, r.stats.maxAlt - r.stats.minAlt);
    const left = `${Math.min(100, Math.max(0, ((r.alt[i] - r.stats.minAlt) / span) * 100))}%`;
    if (altCursor.style.left !== left) altCursor.style.left = left;
    altVal.textContent = `${num(r.alt[i])} M`;

    // Rose: route total faint, walked part filled, the sector under the hiker outlined.
    const { w, h } = rose.begin();
    const ctx = rose.ctx, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 10;
    const top = Math.max(...a.aspect, 0.001);
    ctx.strokeStyle = COLORS.line2;
    for (const f of [0.5, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    const wedge = (k: number, km: number) => {
      const a0 = ((k - 0.5) / 8) * Math.PI * 2 - Math.PI / 2, a1 = ((k + 0.5) / 8) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, (km / top) * R, a0 + 0.04, a1 - 0.04); ctx.closePath();
    };
    a.aspect.forEach((km, k) => {
      const sunny = SUNNY.has(k);
      wedge(k, km);
      ctx.fillStyle = sunny ? COLORS.ac(0.18) : COLORS.ink(0.12);
      ctx.fill();
      wedge(k, a.aspectCum[k][i]);
      ctx.fillStyle = sunny ? COLORS.ac(0.65) : COLORS.ink(0.45);
      ctx.fill();
    });
    const facing = a.aspectSec[i];
    if (facing >= 0) {
      wedge(facing, a.aspect[facing]);
      ctx.strokeStyle = COLORS.accent;
      ctx.stroke();
    }
    ctx.font = FONT(8);
    ctx.fillStyle = COLORS.text3;
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 7); ctx.fillText('S', cx, h - 1);
    ctx.fillText('E', w - 4, cy + 3); ctx.fillText('W', 4, cy + 3);
    ctx.textAlign = 'left';

    // Walking direction as a bug on the outer ring, low-pass filtered the shorter way round.
    const target = walkingAngle(r, i), t = performance.now() / 1000;
    if (target === null) heading = null;
    else if (!heading) heading = { angle: target, t };
    else {
      const diff = Math.atan2(Math.sin(target - heading.angle), Math.cos(target - heading.angle));
      heading.angle += diff * (1 - Math.exp(-Math.max(0, t - heading.t) / HEADING_TAU));
      heading.t = t;
    }
    if (heading) pointer(ctx, cx + Math.cos(heading.angle) * R, cy + Math.sin(heading.angle) * R, heading.angle, COLORS.accent, true, 1.2);
  };
}

/** Screen angle (north up, clockwise from east) of the direction walked at sample i, or null where the track stands still. */
function walkingAngle(r: RouteView, i: number): number | null {
  const k = Math.max(2, Math.round(HEADING_SPAN / r.step)), last = r.e.length - 1;
  const b = Math.max(0, i - k), f = Math.min(last, i + k);
  const de = r.e[f] - r.e[b], dn = r.n[f] - r.n[b];
  return Math.hypot(de, dn) > 1 ? Math.atan2(-dn, de) : null;
}

interface Analysis {
  /** Route km per slope class and per aspect sector. */
  slope: number[];
  aspect: number[];
  /** Steepest slope over 100 m, in %. */
  maxSlope: number;
  /** Name of the summit waypoint, if the route's highest point is one. */
  top: string;
  /** Per sample: aspect sector (−1 on flat ground) and signed slope over about 100 m (%). */
  aspectSec: Int8Array;
  grade: Float32Array;
  /** Per class / sector, the km covered up to each sample. */
  slopeCum: Float32Array[];
  aspectCum: Float32Array[];
}

function analyse(c: Ctx, r: RouteView): Analysis {
  const n = r.alt.length, km = r.step / 1000;
  const smooth = smoothAltitudes(r.alt, 3);
  const slope = [0, 0, 0, 0, 0];
  const aspect = new Array(8).fill(0);
  const aspectSec = new Int8Array(n).fill(-1), grade = new Float32Array(n);
  const slopeCum = slope.map(() => new Float32Array(n)), aspectCum = aspect.map(() => new Float32Array(n));
  let maxSlope = 0;
  const win = Math.max(1, Math.round(100 / r.step)), half = Math.max(1, Math.round(win / 2));
  for (let i = 1; i < n; i++) {
    const s = (Math.abs(smooth[i] - smooth[i - 1]) / r.step) * 100;
    const cls = Math.min(4, Math.floor(s / 10));
    slope[cls] += km;
    if (i >= win) maxSlope = Math.max(maxSlope, (Math.abs(smooth[i] - smooth[i - win]) / (win * r.step)) * 100);
    // Aspect: the compass direction the terrain under the trail faces (downhill direction).
    const e = r.e[i], no = r.n[i], d = 30;
    const gx = c.view.heightAt(e + d, no) - c.view.heightAt(e - d, no), gy = c.view.heightAt(e, no + d) - c.view.heightAt(e, no - d);
    if (Math.hypot(gx, gy) > 2) {
      const sec = Math.round(((Math.atan2(-gx, -gy) / (Math.PI * 2)) * 8 + 8)) % 8;
      aspect[sec] += km;
      aspectSec[i] = sec;
    }
    for (let k = 0; k < 5; k++) slopeCum[k][i] = slopeCum[k][i - 1] + (k === cls ? km : 0);
    for (let k = 0; k < 8; k++) aspectCum[k][i] = aspectCum[k][i - 1] + (k === aspectSec[i] ? km : 0);
  }
  aspectSec[0] = aspectSec[Math.min(1, n - 1)];
  // Signed slope centred on each sample, so the meta reads what the hiker is on now.
  for (let i = 0; i < n; i++) {
    const b = Math.max(0, i - half), f = Math.min(n - 1, i + half);
    grade[i] = f > b ? ((smooth[f] - smooth[b]) / ((f - b) * r.step)) * 100 : 0;
  }
  let top = '';
  const highest = r.waypoints.reduce((b, w) => (w.alt > (b?.alt ?? -1) ? w : b), r.waypoints[0]);
  if (highest && highest.alt >= r.stats.maxAlt - 30) top = c.region.places.get(highest.place)?.name ?? '';
  return { slope, aspect, maxSlope, top, aspectSec, grade, slopeCum, aspectCum };
}

interface LogEvent { minute: number; text: string; hl: boolean }

/** Typewriter speed of new log lines, in characters per second. */
const TYPE_CPS = 55;
/** Delay between the starts of lines that arrive in the same update, in ms. */
const TYPE_STAGGER = 150;
/** Only the newest lines of a batch type; older ones (e.g. after a long scrub) appear whole. */
const TYPE_MAX = 3;

interface Typing { row: HTMLElement; typed: HTMLElement; rest: HTMLElement; text: string; start: number }

/** J · Trail log: what the preview hiker passes, as it happens. New lines type themselves in. */
export function mountLog(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'J', 'Trail log', '', true);
  const list = document.createElement('div');
  list.className = 'log';
  body.appendChild(list);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let events: LogEvent[] = [], shown = 0, built: RouteView | null = null;
  let typing: Typing[] = [], frameId = 0;

  const tick = (now: number) => {
    typing = typing.filter((t) => {
      const n = Math.max(0, Math.floor(((now - t.start) * TYPE_CPS) / 1000));
      if (n >= t.text.length || !t.row.isConnected) {
        t.typed.textContent = t.text;
        t.rest.textContent = '';
        t.row.classList.remove('typing');
        return false;
      }
      if (t.typed.textContent!.length !== n) {
        t.typed.textContent = t.text.slice(0, n);
        t.rest.textContent = t.text.slice(n);
      }
      return true;
    });
    frameId = typing.length ? requestAnimationFrame(tick) : 0;
  };
  const clear = () => {
    list.innerHTML = '';
    shown = 0;
    typing = [];
  };

  return () => {
    const r = c.route(), minute = c.store.state.minute;
    if (built !== r) {
      built = r;
      events = buildEvents(c, r);
      clear();
    }
    meta.textContent = c.store.state.playing ? 'PREVIEW ●' : 'PAUSED';
    if (minute < (events[shown - 1]?.minute ?? -1)) clear();
    let last = shown;
    while (last < events.length && events[last].minute <= minute) last++;
    // New lines start one stagger after the latest line that is still typing.
    let start = Math.max(performance.now(), (typing.at(-1)?.start ?? -Infinity) + TYPE_STAGGER);
    for (; shown < last; shown++) {
      const e = events[shown];
      const row = document.createElement('div');
      row.className = `log-row${e.hl ? ' hl' : ''}`;
      const t = document.createElement('span'), msg = document.createElement('span');
      const typed = document.createElement('span'), rest = document.createElement('span');
      t.className = 't';
      t.textContent = `T+${hm(e.minute)}`;
      typed.className = 'typed';
      rest.className = 'rest';
      msg.append(typed, rest);
      row.append(t, msg);
      if (still || last - shown > TYPE_MAX) typed.textContent = e.text;
      else {
        rest.textContent = e.text;
        row.classList.add('typing');
        typing.push({ row, typed, rest, text: e.text, start });
        start += TYPE_STAGGER;
      }
      list.appendChild(row);
      while (list.children.length > 60) list.firstElementChild!.remove();
    }
    if (typing.length && !frameId) frameId = requestAnimationFrame(tick);
  };
}

function buildEvents(c: Ctx, r: RouteView): LogEvent[] {
  const out: LogEvent[] = [];
  const ids = c.waypointIds();
  const start = c.region.places.get(r.waypoints[0]?.place ?? '');
  out.push({ minute: 0, text: `${r.number ? `Route ${r.number}` : 'Classic'} · ${r.name} · ${r.stats.km.toFixed(1)} km · ↑${r.stats.up} ↓${r.stats.down} m`, hl: true });
  if (start) out.push({ minute: 0, text: `HIKA departs ${start.name} · ${num(r.alt[0])} m`, hl: false });
  for (const w of r.waypoints.slice(1)) {
    const p = c.region.places.get(w.place);
    if (p) out.push({ minute: w.time, text: `HIKA passes ${ids.get(w.place)} ${p.name} · km ${w.km.toFixed(1)} · ${num(w.alt)} m`, hl: false });
  }
  let prev = r.cls[0];
  for (let i = 1; i < r.cls.length; i++) {
    if (r.cls[i] !== prev && (i + 20 >= r.cls.length || r.cls.slice(i, i + 20).every((v) => v === r.cls[i]))) {
      prev = r.cls[i];
      out.push({ minute: r.minutes[i], text: prev === OFF_NETWORK ? `leaves the signposted network · km ${r.km[i].toFixed(1)}` : `enters ${TRAIL_CLASSES[prev]} · km ${r.km[i].toFixed(1)}`, hl: prev === 2 });
    }
  }
  let hi = 0;
  for (let i = 1; i < r.alt.length; i++) if (r.alt[i] > r.alt[hi]) hi = i;
  out.push({ minute: r.minutes[hi], text: `highest point · ${num(r.alt[hi])} m · km ${r.km[hi].toFixed(1)}`, hl: true });
  for (let h = 1; h * 60 < r.minutes[r.minutes.length - 1]; h++) out.push({ minute: h * 60, text: `${h} h on the trail`, hl: false });
  const end = r.minutes[r.minutes.length - 1];
  out.push({ minute: end, text: `HIKA arrives ${r.to} · ${hm(end)} h · ${r.stats.km.toFixed(1)} km`, hl: true });
  return out.sort((a, b) => a.minute - b.minute);
}
