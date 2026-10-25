import { OFF_NETWORK } from '../data/types';
import { pointer } from '../hud/pointer';
import { chart, COLORS, FONT, frame, hm, num, type Ctx } from './common';

const PAD = { l: 34, r: 8, t: 22, b: 16 };

/** E · Elevation profile with waypoint ticks, preview cursor and hover sync. */
export function mountProfile(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'E', 'Elevation profile');
  const ch = chart(body);
  const readout = document.createElement('div');
  readout.style.cssText = 'position:absolute;top:0;right:4px;text-align:right;pointer-events:none';
  readout.innerHTML = '<div style="font-size:9px;color:var(--text-3);letter-spacing:.16em">ALTITUDE</div><div data-v style="font-size:22px;font-weight:300"></div>';
  body.appendChild(readout);
  const v = readout.querySelector<HTMLElement>('[data-v]')!;

  ch.canvas.addEventListener('mousemove', (e) => {
    const r = c.route(), w = ch.canvas.clientWidth;
    const f = (e.offsetX - PAD.l) / (w - PAD.l - PAD.r);
    if (f < 0 || f > 1) return c.store.set({ hoverIndex: null });
    c.store.set({ hoverIndex: Math.round(f * (r.alt.length - 1)) });
  });
  ch.canvas.addEventListener('mouseleave', () => c.store.set({ hoverIndex: null }));
  ch.canvas.addEventListener('click', (e) => {
    const r = c.route(), w = ch.canvas.clientWidth;
    const f = Math.min(1, Math.max(0, (e.offsetX - PAD.l) / (w - PAD.l - PAD.r)));
    c.store.set({ minute: r.minutes[Math.round(f * (r.alt.length - 1))], playing: false });
  });

  return () => {
    const r = c.route(), i = c.hikerIndex(), hover = c.store.state.hoverIndex;
    meta.textContent = `${r.stats.km.toFixed(1)} KM · ↑${num(r.stats.up)} M · ↓${num(r.stats.down)} M`;
    v.textContent = `${num((hover ?? i) < r.alt.length ? r.alt[hover ?? i] : 0)} m`;
    const { w, h } = ch.begin();
    const ctx = ch.ctx;
    const lo = Math.floor(r.stats.minAlt / 100) * 100, hi = Math.ceil(r.stats.maxAlt / 100) * 100 + 100;
    const X = (k: number) => PAD.l + (k / (r.alt.length - 1)) * (w - PAD.l - PAD.r);
    const Y = (a: number) => h - PAD.b - ((a - lo) / (hi - lo)) * (h - PAD.t - PAD.b);
    grid(ctx, w, h, lo, hi, Y);
    // Filled column per pixel, tinted by trail class; walked part brighter.
    const n = r.alt.length;
    for (let x = PAD.l; x < w - PAD.r; x++) {
      const k = Math.round(((x - PAD.l) / (w - PAD.l - PAD.r)) * (n - 1));
      const y = Y(r.alt[k]);
      const cls = r.cls[k] === OFF_NETWORK ? 3 : r.cls[k];
      ctx.fillStyle = COLORS.ink(k <= i ? 0.16 : 0.06);
      ctx.fillRect(x, y, 1, h - PAD.b - y);
      ctx.fillStyle = COLORS.classes[cls];
      ctx.globalAlpha = k <= i ? 1 : 0.55;
      ctx.fillRect(x, y - 0.5, 1, 1.5);
      ctx.globalAlpha = 1;
    }
    // Waypoint ticks.
    ctx.font = FONT(8);
    ctx.textAlign = 'center';
    const ids = c.waypointIds();
    for (const wp of r.waypoints) {
      const k = Math.min(n - 1, Math.round((wp.km * 1000) / r.step));
      const x = X(k);
      ctx.strokeStyle = COLORS.line2;
      ctx.beginPath(); ctx.moveTo(x + 0.5, Y(r.alt[k]) - 3); ctx.lineTo(x + 0.5, h - PAD.b + 3); ctx.stroke();
      ctx.fillStyle = COLORS.text3;
      ctx.fillText(ids.get(wp.place) ?? '', x, h - 4);
    }
    cursor(ctx, X(i), Y(r.alt[i]), heading(X, Y, r.alt, i), PAD.t - 8, h - PAD.b, COLORS.accent, 'HIKA', true);
    if (hover !== null && hover < n) cursor(ctx, X(hover), Y(r.alt[hover]), heading(X, Y, r.alt, hover), PAD.t - 8, h - PAD.b, COLORS.text, `${r.km[hover].toFixed(1)}`, false);
    ctx.textAlign = 'left';
  };
}

/** F · Climb and descent rate in 200 m bins (metres per km), tinted by trail class. */
export function mountGradient(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'F', 'Climb / descent per km');
  const ch = chart(body);
  const BIN = 200;
  return () => {
    const r = c.route(), i = c.hikerIndex();
    meta.textContent = 'M / KM · 200 M BINS';
    const { w, h } = ch.begin();
    const ctx = ch.ctx;
    const per = Math.round(BIN / r.step);
    const bins: { up: number; down: number; cls: number }[] = [];
    for (let s = 0; s < r.alt.length - 1; s += per) {
      const e = Math.min(r.alt.length - 1, s + per), f = 1000 / ((e - s) * r.step);
      const counts = [0, 0, 0, 0];
      for (let k = s; k < e; k++) counts[r.cls[k] === OFF_NETWORK ? 3 : r.cls[k]]++;
      bins.push({ up: (r.up[e] - r.up[s]) * f, down: (r.down[e] - r.down[s]) * f, cls: counts.indexOf(Math.max(...counts)) });
    }
    const max = Math.max(100, ...bins.map((b) => Math.max(b.up, b.down)));
    const mid = PAD.t + (h - PAD.t - PAD.b) / 2, half = (h - PAD.t - PAD.b) / 2 - 2;
    const bw = (w - PAD.l - PAD.r) / Math.max(1, bins.length);
    ctx.font = FONT(8);
    ctx.fillStyle = COLORS.text3;
    ctx.fillText(`+${Math.round(max)}`, 2, PAD.t + 6);
    ctx.fillText(`−${Math.round(max)}`, 2, h - PAD.b);
    ctx.strokeStyle = COLORS.line2;
    ctx.beginPath(); ctx.moveTo(PAD.l, mid + 0.5); ctx.lineTo(w - PAD.r, mid + 0.5); ctx.stroke();
    const hikerBin = Math.floor((i * r.step) / BIN);
    bins.forEach((b, k) => {
      const x = Math.round(PAD.l + k * bw + bw / 2) - 1, bwi = Math.max(1, Math.min(3, bw - 2));
      ctx.globalAlpha = k <= hikerBin ? 1 : 0.4;
      ctx.fillStyle = COLORS.text;
      ctx.fillRect(x, mid - (b.up / max) * half, bwi, (b.up / max) * half);
      ctx.fillStyle = COLORS.classes[b.cls];
      ctx.fillRect(x, mid + 1, bwi, (b.down / max) * half);
      ctx.globalAlpha = 1;
    });
    ctx.fillStyle = COLORS.text3;
    ctx.textAlign = 'center';
    const kmTotal = r.stats.km, every = Math.max(1, Math.ceil(kmTotal / 8));
    for (let km = 0; km <= kmTotal; km += every) ctx.fillText(String(km), PAD.l + ((km * 1000) / BIN) * bw, h - 3);
    ctx.textAlign = 'left';
  };
}

/** H · Cumulative climb and descent against distance, with hourly ticks of hiking time. */
export function mountCumulative(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'H', 'Cumulative climb / descent');
  body.style.height = '150px';
  body.style.flex = 'none';
  const ch = chart(body);
  return () => {
    const r = c.route(), i = c.hikerIndex();
    meta.textContent = `M · KM · ${hm(r.stats.time)} H`;
    const { w, h } = ch.begin();
    const ctx = ch.ctx;
    const n = r.alt.length, max = Math.max(100, r.up[n - 1], r.down[n - 1]);
    const X = (k: number) => PAD.l + (k / (n - 1)) * (w - PAD.l - PAD.r);
    const Y = (v: number) => h - PAD.b - (v / max) * (h - PAD.t - PAD.b);
    grid(ctx, w, h, 0, max, Y, 4);
    for (const [series, color] of [[r.up, COLORS.text], [r.down, COLORS.accent]] as const) {
      ctx.beginPath();
      for (let x = PAD.l; x <= w - PAD.r; x++) {
        const k = Math.round(((x - PAD.l) / (w - PAD.l - PAD.r)) * (n - 1));
        x === PAD.l ? ctx.moveTo(x, Y(series[k])) : ctx.lineTo(x, Y(series[k]));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      pointer(ctx, X(i), Y(series[i]), heading(X, Y, series, i), color);
    }
    // Hour ticks along the top: where the hiker is after 1 h, 2 h, …
    ctx.font = FONT(8);
    ctx.textAlign = 'center';
    for (let hour = 1; hour * 60 < r.minutes[n - 1]; hour++) {
      let k = 0;
      while (k < n - 1 && r.minutes[k] < hour * 60) k++;
      ctx.fillStyle = COLORS.line2;
      ctx.fillRect(X(k), PAD.t - 6, 1, 4);
      ctx.fillStyle = COLORS.text3;
      ctx.fillText(`${hour}H`, X(k), PAD.t - 9);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text2;
    ctx.fillText(`CLIMB ${num(r.up[i])}`, PAD.l + 4, PAD.t + 10);
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(`DESCENT ${num(r.down[i])}`, PAD.l + 4, PAD.t + 21);
  };
}


function grid(ctx: CanvasRenderingContext2D, w: number, _h: number, lo: number, hi: number, Y: (v: number) => number, lines = 3) {
  ctx.font = FONT(8);
  ctx.textAlign = 'right';
  const step = niceStep((hi - lo) / lines);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = COLORS.line;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
    ctx.fillStyle = COLORS.text3;
    ctx.fillText(num(v), PAD.l - 4, y + 3);
  }
  ctx.textAlign = 'left';
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

/** Screen-space direction of a plotted series at sample k, taken over about ±5 px so it doesn't twitch per sample. */
function heading(X: (k: number) => number, Y: (v: number) => number, series: ArrayLike<number>, k: number) {
  const n = series.length, half = Math.max(1, Math.round(5 / Math.max(1e-6, X(1) - X(0))));
  const k0 = Math.max(0, k - half), k1 = Math.min(n - 1, k + half);
  return k1 > k0 ? Math.atan2(Y(series[k1]) - Y(series[k0]), X(k1) - X(k0)) : 0;
}

function cursor(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, top: number, bottom: number, color: string, label: string, fill: boolean) {
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, top); ctx.lineTo(Math.round(x) + 0.5, bottom); ctx.stroke();
  ctx.globalAlpha = 1;
  pointer(ctx, x, y, angle, color, fill);
  ctx.fillStyle = color;
  ctx.font = FONT(8, 400);
  ctx.textAlign = 'center';
  ctx.fillText(label, x, top - 2);
}
