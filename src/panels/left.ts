import { nextWaypoint, type RouteView } from '../data/load';
import { TRAIL_CLASSES } from '../data/types';
import { formatDuration } from '../geo/hikingTime';
import { GLYPH } from '../hud/labels';
import { CATEGORY_ORDER } from '../playlist';
import { COLORS, esc, frame, hm, num, type Ctx } from './common';

/** 12 px stroke icons for the transport buttons; they take the button's text colour. */
const ICON: Record<string, string> = {
  prev: 'M2.5 2v8M10 2 4 6l6 4z',
  next: 'M9.5 2v8M2 2l6 4-6 4z',
  play: 'M3 1.5 10.5 6 3 10.5z',
  pause: 'M4 2v8M8 2v8',
  repeat: 'M1.5 6.5V5A2 2 0 0 1 3.5 3H10M8.5 1.5 10 3 8.5 4.5M10.5 5.5V7A2 2 0 0 1 8.5 9H2M3.5 10.5 2 9l1.5-1.5',
  shuffle: 'M1 3h2.5l5 6H11M1 9h2.5l5-6H11M9.5 1.5 11 3 9.5 4.5M9.5 7.5 11 9l-1.5 1.5',
};
const icon = (k: string) => `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${ICON[k]}"/></svg>`;

/**
 * A · Route player: a virtual hiker walking the region's routes at Swiss signpost pace, one after
 * another like a playlist, with its progress in distance, climb and time (the hiker callout on the map shows the altitude).
 */
export function mountPreview(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'A', 'Route player');
  body.innerHTML = `
    <div class="now-playing">
      <div class="np-name" data-k="name"></div><div class="np-ends" data-k="ends"></div>
    </div>
    <div class="kv">
      <div><div class="k">HIKA · KM</div><div class="v nowrap"><span data-k="km">0.0</span><small data-k="kmTotal"></small></div></div>
      <div><div class="k">CLIMB · M</div><div class="v nowrap"><span data-k="up">0</span><small data-k="upTotal"></small></div></div>
      <div><div class="k">ELAPSED</div><div class="v nowrap"><span data-k="time">0:00</span><small data-k="total"></small></div></div>
      <div class="full"><div class="k">NEXT POINT</div><div class="v" data-k="next" style="font-size:13px">—</div></div>
    </div>
    <div class="preview-bar">
      <div class="scrub" data-k="track">
        <div class="ticks" data-k="ticks"></div>
        <span class="mark" aria-hidden="true"></span>
        <input type="range" min="0" max="1000" value="0" data-k="scrub" aria-label="Preview position" />
      </div>
      <div class="transport">
        <button class="btn icon" data-k="back" aria-label="Previous route" title="Previous route (←)">${icon('prev')}</button>
        <button class="btn icon" data-k="play"></button>
        <button class="btn icon" data-k="fwd" aria-label="Next route" title="Next route (→)">${icon('next')}</button>
        <span class="spacer"></span>
        <button class="btn icon" data-k="repeat" aria-pressed="false" aria-label="Repeat this route" title="Repeat this route instead of moving on">${icon('repeat')}</button>
        <button class="btn icon" data-k="shuffle" aria-pressed="false" aria-label="Shuffle routes" title="Play the routes in a random order">${icon('shuffle')}</button>
        <button class="btn" data-k="rev" aria-pressed="false">⇄ REV</button>
      </div>
    </div>`;
  const q = (k: string) => body.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
  const scrub = q('scrub') as HTMLInputElement;
  const track = q('track');
  let ticks: HTMLElement[] = [];
  let built: RouteView | null = null;
  let playing: boolean | null = null;
  // The header readout ("1 H = 3 S") is also the speed control.
  meta.innerHTML = '<button class="speed"></button>';
  const speed = meta.querySelector('button')!;
  let shownSpeed = 0;
  const speeds = [1.5, 3, 6];
  q('back').onclick = () => c.skip(-1);
  q('fwd').onclick = () => c.skip(1);
  q('play').onclick = () => c.store.set({ playing: !c.store.state.playing });
  q('repeat').onclick = () => c.store.set({ repeat: !c.store.state.repeat });
  q('shuffle').onclick = () => c.store.set({ shuffle: !c.store.state.shuffle });
  speed.onclick = () => {
    const i = speeds.indexOf(c.store.state.secondsPerHour);
    c.store.set({ secondsPerHour: speeds[(i + 1) % speeds.length] });
  };
  // Reversing restarts the preview at the new departure.
  q('rev').onclick = () => c.store.set({ reversed: !c.store.state.reversed, minute: 0 });
  scrub.oninput = () => {
    // The playhead is drawn from --p, so move it now rather than on the next poll.
    track.style.setProperty('--p', String(+scrub.value / 1000));
    c.store.set({ minute: (+scrub.value / 1000) * c.route().minutes[c.route().minutes.length - 1], playing: false });
  };

  return () => {
    const r = c.route(), i = c.hikerIndex(), s = c.store.state;
    const total = r.minutes[r.minutes.length - 1];
    if (built !== r) {
      // One tick per waypoint, placed by walking time so it lines up with the scrubber.
      built = r;
      q('ticks').innerHTML = r.waypoints.map((w) => `<i style="--f:${Math.min(1, w.time / total)}"></i>`).join('');
      ticks = [...q('ticks').children] as HTMLElement[];
      q('name').textContent = `${r.number ? `${r.number} ·` : '★'} ${r.name.toUpperCase()}`;
      q('name').title = `${r.name} (${r.from} → ${r.to})`;
      q('ends').textContent = `${r.from} → ${r.to}`;
      // Totals from the per-sample series, so the reversed view gets its own climb.
      const last = r.km.length - 1;
      q('kmTotal').textContent = `/ ${r.km[last].toFixed(1)}`;
      q('upTotal').textContent = `/ ${num(r.up[last])}`;
      q('total').textContent = `/ ${hm(total)}`;
    }
    if (playing !== s.playing) {
      playing = s.playing;
      q('play').innerHTML = icon(playing ? 'pause' : 'play');
      q('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
      q('play').title = `${playing ? 'Pause' : 'Play'} (space)`;
    }
    q('repeat').setAttribute('aria-pressed', String(s.repeat));
    q('shuffle').setAttribute('aria-pressed', String(s.shuffle));
    track.style.setProperty('--p', String(Math.min(1, s.minute / total)));
    r.waypoints.forEach((w, k) => ticks[k].classList.toggle('passed', w.time <= s.minute));
    if (shownSpeed !== s.secondsPerHour) {
      shownSpeed = s.secondsPerHour;
      speed.textContent = `1 H = ${shownSpeed} S`;
      speed.title = `Preview speed: 1 hiking hour in ${shownSpeed} s. Click to change.`;
      speed.setAttribute('aria-label', speed.title);
    }
    q('km').textContent = r.km[i].toFixed(1);
    q('up').textContent = num(r.up[i]);
    q('time').textContent = hm(r.minutes[i]);
    const next = r.waypoints[nextWaypoint(r, i)];
    const p = next && c.region.places.get(next.place);
    q('next').textContent = p ? `${c.waypointIds().get(next.place)} · ${p.name} · ${hm(Math.max(0, next.time - r.minutes[i]))}` : 'ARRIVED';
    q('rev').setAttribute('aria-pressed', String(s.reversed));
    q('rev').title = `Walk it the other way: ${r.to} → ${r.from}`;
    if (document.activeElement !== scrub) scrub.value = String(Math.round((s.minute / total) * 1000));
  };
}

/** B · Waypoints, with signpost-rounded cumulative times. */
export function mountWaypoints(el: HTMLElement, c: Ctx) {
  const { body, meta } = frame(el, 'B', 'Waypoints', '', true);
  let rows: HTMLTableRowElement[] = [];
  let built: RouteView | null = null;

  return () => {
    const r = c.route();
    if (built !== r) {
      built = r;
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
  const net = c.region.summary;
  const netTotal = net.trailKm[0] + net.trailKm[1] + net.trailKm[2];
  meta.textContent = `NETWORK ${num(netTotal)} KM`;
  let built: RouteView | null = null;
  return () => {
    const r = c.route();
    if (built === r) return;
    built = r;
    const km = r.stats.classKm, total = r.stats.km || 1;
    const labels = [...TRAIL_CLASSES.map((t) => t.toUpperCase()), 'OFF NETWORK'];
    const stack = km.map((k, i) => (k > 0 ? `<div style="width:${(k / total) * 100}%;background:${CLASS_VARS[i]}" title="${labels[i]} ${k} km"></div>` : '')).join('');
    const rows = km.map((k, i) => {
      if (i === 3 && k === 0) return '';
      const ghost = i < 3 ? `<span class="ghost" style="left:${(net.trailKm[i] / netTotal) * 100}%" title="share in the regional network"></span>` : '';
      return `<div class="bar-row"><span>${labels[i]}</span><span class="track"><span class="fillbar" style="width:${(k / total) * 100}%;background:${CLASS_VARS[i]}"></span>${ghost}</span><span class="val">${k.toFixed(1)} KM</span></div>`;
    }).join('');
    body.innerHTML = `<div class="stack">${stack}</div><div class="bars">${rows}
      <div class="bar-row"><span>HARD SURFACE</span><span class="track"><span class="fillbar" style="width:${(r.stats.hardKm / total) * 100}%;background:var(--text-2)"></span><span class="ghost" style="left:${(net.hardKm / netTotal) * 100}%"></span></span><span class="val">${r.stats.hardKm.toFixed(1)} KM</span></div></div>`;
  };
}

// The classics group is prefixed with the region title.
const GROUP_TITLES: Record<RouteView['category'], string> = { classic: 'CLASSICS · ROUTED ON SWISSTLM3D', national: 'NATIONAL ROUTES', regional: 'REGIONAL ROUTES', local: 'LOCAL ROUTES' };
// Same order as the preview playlist.
const GROUPS = CATEGORY_ORDER.map((cat) => [cat, GROUP_TITLES[cat]] as const);

/** D · Route switcher: every official and curated route in the region. */
export function mountRoutes(el: HTMLElement, c: Ctx) {
  const { body } = frame(el, 'D', `Routes · ${c.region.summary.title}`, `${c.region.routes.length} ROUTES`, true);
  const list = document.createElement('div');
  list.className = 'routes';
  body.appendChild(list);
  const buttons = new Map<string, HTMLButtonElement>();
  const sparks: [HTMLCanvasElement, RouteView][] = [];
  for (const [cat, title] of GROUPS) {
    const routes = c.region.routes.filter((r) => r.category === cat);
    if (!routes.length) continue;
    list.insertAdjacentHTML('beforeend', `<div class="route-group">${cat === 'classic' ? `${esc(c.region.summary.title.toUpperCase())} ` : ''}${title}</div>`);
    for (const r of routes) {
      const b = document.createElement('button');
      b.className = 'route-row';
      const climbs = `↑${r.stats.up} ↓${r.stats.down}`;
      b.innerHTML = `<span class="no">${r.number ?? '★'}</span><span class="nm" title="${esc(r.name)} (${esc(r.from)} → ${esc(r.to)})">${esc(r.name)}</span><canvas></canvas>
        <span class="st"><span>${r.stats.km.toFixed(1)} KM</span><span>${climbs}</span><span>${formatDuration(r.stats.time, true)}</span></span>`;
      b.onclick = () => c.store.set({ routeId: r.id, reversed: r.id === c.store.state.routeId && c.store.state.reversed, minute: 0, playing: true });
      // Mouse only: a tap would leave the hover set, ghosting this route once another one plays.
      b.onpointerenter = (e) => { if (e.pointerType === 'mouse') c.store.set({ hoverRouteId: r.id }); };
      b.onpointerleave = () => c.store.set({ hoverRouteId: null });
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

