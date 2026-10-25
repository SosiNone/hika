import { nextWaypoint, type RouteView } from '../data/load';
import { TRAIL_CLASSES } from '../data/types';
import { formatDuration } from '../geo/hikingTime';
import { GLYPH } from '../hud/labels';
import { COLORS, esc, frame, hm, num, type Ctx } from './common';

/** A · Trail preview: a virtual hiker walking the route at Swiss signpost pace. */
export function mountPreview(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'A', 'Trail preview');
  body.innerHTML = `
    <div class="kv">
      <div><div class="k">HIKA · KM</div><div class="v" data-k="km">0.0</div></div>
      <div><div class="k">ALTITUDE · M</div><div class="v" data-k="alt">0</div></div>
      <div><div class="k">D+ SO FAR · M</div><div class="v" data-k="up">0</div></div>
      <div><div class="k">ELAPSED</div><div class="v" data-k="time">0:00</div></div>
      <div class="wide"><div class="k">NEXT POINT</div><div class="v" data-k="next" style="font-size:13px">—</div></div>
    </div>
    <div class="preview-bar">
      <button class="btn" data-k="play">PAUSE</button>
      <input type="range" min="0" max="1000" value="0" data-k="scrub" aria-label="Preview position" />
      <button class="btn" data-k="speed"></button>
    </div>`;
  const q = (k: string) => body.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
  const scrub = q('scrub') as HTMLInputElement;
  const speeds = [1.5, 3, 6];
  q('play').onclick = () => c.store.set({ playing: !c.store.state.playing });
  q('speed').onclick = () => {
    const i = speeds.indexOf(c.store.state.secondsPerHour);
    c.store.set({ secondsPerHour: speeds[(i + 1) % speeds.length] });
  };
  scrub.oninput = () => c.store.set({ minute: (+scrub.value / 1000) * c.route().minutes[c.route().minutes.length - 1], playing: false });

  return () => {
    const r = c.route(), i = c.hikerIndex(), s = c.store.state;
    const total = r.minutes[r.minutes.length - 1];
    meta.textContent = `1 H = ${s.secondsPerHour} S`;
    q('km').textContent = r.km[i].toFixed(1);
    q('alt').textContent = num(r.alt[i]);
    q('up').textContent = num(r.up[i]);
    q('time').textContent = hm(r.minutes[i]);
    const next = r.waypoints[nextWaypoint(r, i)];
    const p = next && c.region.places.get(next.place);
    q('next').textContent = p ? `${c.waypointIds().get(next.place)} · ${p.name} · ${hm(Math.max(0, next.time - r.minutes[i]))}` : 'ARRIVED';
    q('play').textContent = s.playing ? 'PAUSE' : 'PLAY';
    q('speed').textContent = `×${(3 / s.secondsPerHour).toFixed(1).replace('.0', '')}`;
    if (document.activeElement !== scrub) scrub.value = String(Math.round((s.minute / total) * 1000));
  };
}

/** B · Waypoints, with signpost-rounded cumulative times. */
export function mountWaypoints(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'B', 'Waypoints', '', true);
  let rows: HTMLTableRowElement[] = [];
  let built = '';

  return () => {
    const r = c.route();
    if (built !== r.id) {
      built = r.id;
      meta.textContent = `SIGNPOST TIME · ${formatDuration(r.stats.time, true)}`;
      const ids = c.waypointIds();
      body.innerHTML = `<table class="list"><thead><tr><th>ID</th><th>POINT</th><th class="num">KM</th><th class="num">ALT</th><th class="num">⌛</th></tr></thead><tbody>${r.waypoints
        .map((w) => {
          const p = c.region.places.get(w.place)!;
          return `<tr><td>${ids.get(w.place)}</td><td class="name" title="${esc(p.name)}"><span class="glyph">${GLYPH[p.kind]}</span>${esc(p.name)}</td><td class="num">${w.km.toFixed(1)}</td><td class="num">${w.alt}</td><td class="num">${formatDuration(w.time, true)}</td></tr>`;
        }).join('')}</tbody></table>`;
      rows = [...body.querySelectorAll('tbody tr')] as HTMLTableRowElement[];
    }
    const next = nextWaypoint(r, c.hikerIndex());
    r.waypoints.forEach((_, k) => {
      rows[k].classList.toggle('passed', (next < 0 || k < next) && k < r.waypoints.length - 1);
      rows[k].classList.toggle('next', k === next);
    });
  };
}

const CLASS_VARS = ['var(--wander)', 'var(--berg)', 'var(--alpin)', 'var(--text-3)'];

/** C · Trail class composition of the route compared with the whole regional network. */
export function mountTrailClass(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'C', 'Trail class');
  const net = c.region.bundle.trails;
  const netTotal = net.km[0] + net.km[1] + net.km[2];
  meta.textContent = `NETWORK ${num(netTotal)} KM`;
  let built = '';
  return () => {
    const r = c.route();
    if (built === r.id) return;
    built = r.id;
    const km = r.stats.classKm, total = r.stats.km || 1;
    const labels = [...TRAIL_CLASSES.map((t) => t.toUpperCase()), 'OFF NETWORK'];
    const stack = km.map((k, i) => (k > 0 ? `<div style="width:${(k / total) * 100}%;background:${CLASS_VARS[i]}" title="${labels[i]} ${k} km"></div>` : '')).join('');
    const rows = km.map((k, i) => {
      if (i === 3 && k === 0) return '';
      const ghost = i < 3 ? `<span class="ghost" style="left:${(net.km[i] / netTotal) * 100}%" title="share in the regional network"></span>` : '';
      return `<div class="bar-row"><span>${labels[i]}</span><span class="track"><span class="fillbar" style="width:${(k / total) * 100}%;background:${CLASS_VARS[i]}"></span>${ghost}</span><span class="val">${k.toFixed(1)} KM</span></div>`;
    }).join('');
    body.innerHTML = `<div class="stack">${stack}</div><div class="bars">${rows}
      <div class="bar-row"><span>HARD SURFACE</span><span class="track"><span class="fillbar" style="width:${(r.stats.hardKm / total) * 100}%;background:var(--text-2)"></span><span class="ghost" style="left:${(net.hardKm / netTotal) * 100}%"></span></span><span class="val">${r.stats.hardKm.toFixed(1)} KM</span></div></div>`;
  };
}

const GROUPS: [RouteView['category'], string][] = [['classic', 'ALPSTEIN CLASSICS · ROUTED ON SWISSTLM3D'], ['national', 'NATIONAL ROUTES'], ['regional', 'REGIONAL ROUTES'], ['local', 'LOCAL ROUTES']];

/** D · Route switcher: every official and curated route in the region. */
export function mountRoutes(el: HTMLElement, c: Ctx) {
  const { body } = frame(el, 'D', `Routes · ${c.region.bundle.title}`, `${c.region.routes.length} ROUTES`, true);
  const list = document.createElement('div');
  list.className = 'routes';
  body.appendChild(list);
  const buttons = new Map<string, HTMLButtonElement>();
  const sparks: [HTMLCanvasElement, RouteView][] = [];
  for (const [cat, title] of GROUPS) {
    const routes = c.region.routes.filter((r) => r.category === cat);
    if (!routes.length) continue;
    list.insertAdjacentHTML('beforeend', `<div class="route-group">${title}</div>`);
    for (const r of routes) {
      const b = document.createElement('button');
      b.className = 'route-row';
      const climbs = `↑${r.stats.up} ↓${r.stats.down}`;
      b.innerHTML = `<span class="no">${r.number ?? '★'}</span><span class="nm" title="${esc(r.name)} (${esc(r.from)} → ${esc(r.to)})">${esc(r.name)}</span><canvas></canvas>
        <span class="st"><span>${r.stats.km.toFixed(1)} KM</span><span>${climbs}</span><span>${formatDuration(r.stats.time, true)}</span>${r.clipped.some(Boolean) ? '<span title="continues beyond the region">✂</span>' : ''}</span>`;
      b.onclick = () => c.store.set({ routeId: r.id, minute: 0, playing: true });
      b.onmouseenter = () => c.store.set({ hoverRouteId: r.id });
      b.onmouseleave = () => c.store.set({ hoverRouteId: null });
      list.appendChild(b);
      buttons.set(r.id, b);
      sparks.push([b.querySelector('canvas')!, r]);
    }
  }
  requestAnimationFrame(() => { for (const [cv, r] of sparks) sparkline(cv, r); });
  let current = '', display = c.store.state.display;
  return () => {
    // Sparklines are drawn once; a scheme change repaints them.
    if (c.store.state.display !== display) {
      display = c.store.state.display;
      for (const [cv, r] of sparks) sparkline(cv, r);
    }
    const id = c.store.state.routeId;
    if (id === current) return;
    current = id;
    for (const [rid, b] of buttons) b.setAttribute('aria-current', String(rid === id));
    // Scroll only the list's own container, never the page (scrollIntoView would on small screens).
    const b = buttons.get(id);
    if (b && body.scrollHeight > body.clientHeight) {
      const top = b.offsetTop - body.offsetTop;
      if (top < body.scrollTop || top + b.offsetHeight > body.scrollTop + body.clientHeight) body.scrollTop = top - body.clientHeight / 3;
    }
  };
}

function sparkline(canvas: HTMLCanvasElement, r: RouteView) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { minAlt, maxAlt } = r.stats;
  const n = r.alt.length;
  ctx.beginPath();
  for (let x = 0; x <= w; x++) {
    const i = Math.min(n - 1, Math.round((x / w) * (n - 1)));
    const y = h - 2 - ((r.alt[i] - minAlt) / Math.max(1, maxAlt - minAlt)) * (h - 4);
    x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  const km = r.stats.classKm.slice(0, 3);
  ctx.strokeStyle = COLORS.classes[km.indexOf(Math.max(...km))];
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  ctx.stroke();
}

