import type { RouteView } from '../data/load';
import { OFF_NETWORK, TRAIL_CLASSES } from '../data/types';
import { smoothAltitudes } from '../geo/hikingTime';
import { lv95ToWgs84 } from '../geo/lv95';
import { chart, COLORS, esc, FONT, frame, hm, num, type Ctx } from './common';

/** G · Switzerland locator: a swaying point-cloud relief of the country with the region boxed. */
export function mountLocator(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'G', 'Switzerland');
  body.style.height = '150px';
  body.style.flex = 'none';
  const ch = chart(body);
  const L = c.region.bundle.locator, bb = c.region.bundle.bbox;
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
    ctx.lineWidth = 1;
    for (const r of L.cantons) ring(r, COLORS.ink(0.12));
    for (const r of L.border) ring(r, COLORS.ink(0.55));
    ring([bb[0], bb[1], bb[2], bb[1], bb[2], bb[3], bb[0], bb[3]], COLORS.accent);
    const [rx, ry] = P((bb[0] + bb[2]) / 2 - cE, cN - (bb[1] + bb[3]) / 2, 0);
    const pulse = (t * 0.8) % 1;
    ctx.strokeStyle = COLORS.ac(1 - pulse);
    ctx.beginPath(); ctx.arc(rx, ry, 4 + pulse * 14, 0, Math.PI * 2); ctx.stroke();
    ctx.font = FONT(8);
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(c.region.bundle.title.toUpperCase(), rx + 10, ry - 8);
  };
}

/** I · Terrain analysis along the route: slope classes, slope aspect and extremes. */
export function mountTerrainStats(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'I', 'Terrain analysis');
  body.style.display = 'grid';
  body.style.gridTemplateColumns = '1fr 92px';
  body.style.gap = '10px';
  const bars = document.createElement('div');
  bars.className = 'bars';
  const roseBox = document.createElement('div');
  roseBox.style.position = 'relative';
  roseBox.style.height = '92px';
  body.append(bars, roseBox);
  const rose = chart(roseBox);
  let built = '';
  let sectors: number[] = [];
  return () => {
    const r = c.route();
    if (built !== r.id) {
      built = r.id;
      const a = analyse(c, r);
      sectors = a.aspect;
      meta.textContent = `MAX SLOPE ${a.maxSlope.toFixed(0)} %`;
      const labels = ['0–10 %', '10–20 %', '20–30 %', '30–40 %', '> 40 %'];
      const max = Math.max(...a.slope);
      bars.innerHTML = a.slope.map((km, i) => `<div class="bar-row" style="grid-template-columns:62px 1fr 48px"><span>${labels[i]}</span><span class="track"><span class="fillbar" style="width:${(km / max) * 100}%;background:${i === 4 ? 'var(--berg)' : 'var(--text-2)'}"></span></span><span class="val">${km.toFixed(1)} KM</span></div>`).join('') +
        `<div class="bar-row" style="grid-template-columns:62px 1fr;margin-top:2px"><span>HIGH · LOW</span><span style="color:var(--text)">${num(r.stats.maxAlt)} · ${num(r.stats.minAlt)} M${a.top ? ` · ${esc(a.top)}` : ''}</span></div>`;
    }
    const { w, h } = rose.begin();
    const ctx = rose.ctx, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 10;
    const max = Math.max(...sectors, 0.001);
    ctx.strokeStyle = COLORS.line2;
    for (const f of [0.5, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    sectors.forEach((km, k) => {
      const a0 = ((k - 0.5) / 8) * Math.PI * 2 - Math.PI / 2, a1 = ((k + 0.5) / 8) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, (km / max) * R, a0 + 0.04, a1 - 0.04); ctx.closePath();
      ctx.fillStyle = k === 3 || k === 4 || k === 5 ? COLORS.ac(0.65) : COLORS.ink(0.45);
      ctx.fill();
    });
    ctx.font = FONT(8);
    ctx.fillStyle = COLORS.text3;
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 7); ctx.fillText('S', cx, h - 1);
    ctx.fillText('E', w - 4, cy + 3); ctx.fillText('W', 4, cy + 3);
    ctx.textAlign = 'left';
  };
}

function analyse(c: Ctx, r: RouteView) {
  const smooth = smoothAltitudes(r.alt, 3);
  const slope = [0, 0, 0, 0, 0];
  const aspect = new Array(8).fill(0);
  let maxSlope = 0;
  const win = Math.max(1, Math.round(100 / r.step));
  for (let i = 1; i < r.alt.length; i++) {
    const s = (Math.abs(smooth[i] - smooth[i - 1]) / r.step) * 100;
    slope[Math.min(4, Math.floor(s / 10))] += r.step / 1000;
    if (i >= win) maxSlope = Math.max(maxSlope, (Math.abs(smooth[i] - smooth[i - win]) / (win * r.step)) * 100);
    // Aspect: the compass direction the terrain under the trail faces (downhill direction).
    const e = r.e[i], n = r.n[i], d = 30;
    const gx = c.view.heightAt(e + d, n) - c.view.heightAt(e - d, n), gy = c.view.heightAt(e, n + d) - c.view.heightAt(e, n - d);
    if (Math.hypot(gx, gy) > 2) aspect[Math.round(((Math.atan2(-gx, -gy) / (Math.PI * 2)) * 8 + 8)) % 8] += r.step / 1000;
  }
  let top = '';
  const highest = r.waypoints.reduce((b, w) => (w.alt > (b?.alt ?? -1) ? w : b), r.waypoints[0]);
  if (highest && highest.alt >= r.stats.maxAlt - 30) top = c.region.places.get(highest.place)?.name ?? '';
  return { slope, aspect, maxSlope, top };
}

interface LogEvent { minute: number; text: string; hl: boolean }

/** J · Trail log: what the preview hiker passes, as it happens. */
export function mountLog(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'J', 'Trail log', '', true);
  const list = document.createElement('div');
  list.className = 'log';
  body.appendChild(list);
  let events: LogEvent[] = [], shown = 0, built = '';
  return () => {
    const r = c.route(), minute = c.store.state.minute;
    if (built !== r.id) {
      built = r.id;
      events = buildEvents(c, r);
      shown = 0;
      list.innerHTML = '';
    }
    meta.textContent = c.store.state.playing ? 'PREVIEW ●' : 'PAUSED';
    if (minute < (events[shown - 1]?.minute ?? -1)) { list.innerHTML = ''; shown = 0; }
    while (shown < events.length && events[shown].minute <= minute) {
      const e = events[shown++];
      const row = document.createElement('div');
      row.className = `log-row${e.hl ? ' hl' : ''}`;
      row.innerHTML = `<span class="t">T+${hm(e.minute)}</span><span>${esc(e.text)}</span>`;
      list.appendChild(row);
      while (list.children.length > 60) list.firstElementChild!.remove();
    }
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
