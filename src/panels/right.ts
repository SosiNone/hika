import type { RouteView } from '../data/load';
import { OFF_NETWORK, TRAIL_CLASSES, type RegionSummary } from '../data/types';
import { smoothAltitudes } from '../geo/hikingTime';
import { lv95ToWgs84 } from '../geo/lv95';
import { pointer } from '../hud/pointer';
import { chart, COLORS, esc, FONT, frame, hm, num, type Ctx } from './common';

/**
 * G · Switzerland locator: a swaying point-cloud relief of the country with the region boxed. The
 * other regions are boxed too, dimmer; hovering one highlights it and a click opens it.
 */
export function mountLocator(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'G', 'Switzerland');
  body.style.height = '150px';
  body.style.flex = 'none';
  const ch = chart(body);
  const L = c.region.bundle.locator, bb = c.region.bundle.bbox;
  const others = c.regions.filter((r) => r.id !== c.region.bundle.id);
  /** Screen rectangles [x0, y0, x1, y1] of the other regions' boxes and labels, as last drawn. */
  let targets: { region: RegionSummary; rect: number[] }[] = [];
  let hover: string | null = null;
  const at = (e: MouseEvent) => {
    const r = ch.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return targets.find(({ rect }) => x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3])?.region ?? null;
  };
  ch.canvas.addEventListener('pointermove', (e) => {
    const r = at(e);
    hover = r?.id ?? null;
    ch.canvas.style.cursor = r ? 'pointer' : '';
    ch.canvas.title = r ? `${r.title}: ${r.subtitle} · ${r.routes} routes` : '';
  });
  ch.canvas.addEventListener('pointerleave', () => { hover = null; });
  ch.canvas.addEventListener('click', (e) => { const r = at(e); if (r) c.goToRegion(r.id); });
  const cE = (L.bbox[0] + L.bbox[2]) / 2, cN = (L.bbox[1] + L.bbox[3]) / 2;
  const [lon, lat] = lv95ToWgs84((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
  meta.textContent = `${lat.toFixed(2)}N ${lon.toFixed(2)}E`;
  const pts: [number, number, number][] = [];
  for (let j = 0; j < L.rows; j++) for (let i = 0; i < L.cols; i++) {
    const h = c.region.swiss[j * L.cols + i];
    if (h) pts.push([L.bbox[0] + (i + 0.5) * L.cell - cE, cN - (L.bbox[3] - (j + 0.5) * L.cell), h * 0.1]);
  }

  return (t: number) => {
    const { w, h } = ch.begin();
    const ctx = ch.ctx;
    // Before layout (e.g. a page loaded hidden) the canvas is 0 × 0, and createImageData would throw.
    if (!ctx.canvas.width || !ctx.canvas.height) return;
    const theta = 0.32 * Math.sin(t * 0.12), tilt = 0.95;
    const s = Math.min((w - 16) / (L.bbox[2] - L.bbox[0]), (h - 10) / ((L.bbox[3] - L.bbox[1]) * Math.cos(tilt) + 5000));
    const ct = Math.cos(theta), st = Math.sin(theta);
    const P = (x: number, z: number, alt: number): [number, number] => {
      const xr = x * ct - z * st, zr = x * st + z * ct;
      return [w / 2 + xr * s, h / 2 + 8 + zr * s * Math.cos(tilt) - alt * 4 * s * Math.sin(tilt)];
    };
    const img = ctx.createImageData(ctx.canvas.width, ctx.canvas.height);
    const dpr = ctx.canvas.width / w;
    // Relief brightens from the background towards the scheme's terrain colour with altitude.
    const bg = COLORS.gl.clear, hi = COLORS.gl.high;
    for (const [x, z, alt] of pts) {
      const [sx, sy] = P(x, z, alt);
      const px = Math.round(sx * dpr), py = Math.round(sy * dpr);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const k = (py * img.width + px) * 4, f = (60 + Math.min(195, alt / 18)) / 255;
      for (let ch = 0; ch < 3; ch++) img.data[k + ch] = 255 * (bg[ch] + (hi[ch] - bg[ch]) * f);
      img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const ring = (flat: number[], color: string, close = true) => {
      ctx.beginPath();
      for (let k = 0; k < flat.length; k += 2) {
        const [sx, sy] = P(flat[k] - cE, cN - flat[k + 1], 0);
        k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      }
      if (close) ctx.closePath();
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    const box = (b: number[]) => [b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]];
    ctx.lineWidth = 1;
    for (const r of L.cantons) ring(r, COLORS.ink(0.12));
    for (const r of L.border) ring(r, COLORS.ink(0.55));
    targets = others.map((r) => {
      const corners = box(r.bbox), xs: number[] = [], ys: number[] = [];
      ring(corners, r.id === hover ? COLORS.text : COLORS.ink(0.55));
      for (let k = 0; k < 8; k += 2) {
        const [sx, sy] = P(corners[k] - cE, cN - corners[k + 1], 0);
        xs.push(sx); ys.push(sy);
      }
      // Padded: a box is only a dozen pixels across.
      return { region: r, rect: [Math.min(...xs) - 6, Math.min(...ys) - 6, Math.max(...xs) + 6, Math.max(...ys) + 6] };
    });
    ring(box(bb), COLORS.accent);
    const [rx, ry] = P((bb[0] + bb[2]) / 2 - cE, cN - (bb[1] + bb[3]) / 2, 0);
    const pulse = (t * 0.8) % 1;
    ctx.strokeStyle = COLORS.ac(1 - pulse);
    ctx.beginPath(); ctx.arc(rx, ry, 4 + pulse * 14, 0, Math.PI * 2); ctx.stroke();
    ctx.font = FONT(8);
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(c.region.bundle.title.toUpperCase(), rx + 10, ry - 8);
    // The hovered region's name, on a plate like the map's hover readout: other regions often sit on
    // the brightest relief.
    const hovered = targets.find((tg) => tg.region.id === hover);
    if (hovered) {
      const name = hovered.region.title.toUpperCase(), tw = ctx.measureText(name).width;
      const lx = Math.min(w - tw - 4, hovered.rect[2] + 2), ly = hovered.rect[1] + 2;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(lx - 3, ly - 2, tw + 6, 12);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(name, lx, ly + 7);
    }
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
