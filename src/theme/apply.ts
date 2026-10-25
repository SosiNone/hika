import { DEFAULT_DISPLAY, hexRgb, isDisplay, resolve, type Display, type Resolved, type RGB } from './tokens';

const KEY = 'hika.display';
const PARAMS = ['theme', 'style', 'scheme'] as const;

/**
 * Colours for Canvas2D and WebGL code, mutated in place on every display change so callers
 * can keep a reference. Nothing that draws should hard-code a colour.
 */
export const palette = {
  text: '', text2: '', text3: '', line: '', line2: '', accent: '', bg: '',
  /** Wanderweg, Bergwanderweg, Alpinwanderweg, off-network. */
  classes: ['', '', '', ''],
  gl: null as unknown as Resolved['gl'],
  /** rgba() of the text colour. */
  ink: (a: number) => rgba(textRgb, a),
  /** rgba() of the accent. */
  ac: (a: number) => rgba(accentRgb, a),
  /** rgba() of the background. */
  bgA: (a: number) => rgba(bgRgb, a),
  /** The accent lifted towards the text colour, for emphasised text on the terrain. */
  accentTint: '',
};
let textRgb: RGB = [0, 0, 0], accentRgb: RGB = [0, 0, 0], bgRgb: RGB = [0, 0, 0];
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** Saved choice, overridden by `?theme=&style=&scheme=` (the hash belongs to `#route=`). */
export function loadDisplay(): Display {
  let saved: Partial<Display> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { /* storage blocked or corrupt */ }
  const q = new URLSearchParams(location.search);
  const d = { ...DEFAULT_DISPLAY, ...saved };
  for (const k of PARAMS) { const v = q.get(k); if (v) (d as Record<string, string>)[k] = v; }
  return isDisplay(d) ? d : DEFAULT_DISPLAY;
}

/** Remembers a choice made in the UI and drops URL overrides so a reload keeps it. */
export function saveDisplay(d: Display) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage blocked */ }
  const q = new URLSearchParams(location.search);
  if (PARAMS.some((k) => q.has(k))) {
    for (const k of PARAMS) q.delete(k);
    const search = q.toString();
    history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
  }
}

export function applyDisplay(d: Display): Resolved {
  const r = resolve(d);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(r.css)) root.style.setProperty(k, v);
  root.dataset.theme = d.theme;
  root.dataset.style = d.style;
  root.dataset.scheme = d.scheme;
  root.style.colorScheme = d.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', r.ladder.bg);

  const L = r.ladder;
  textRgb = hexRgb(L.text); accentRgb = hexRgb(r.accent); bgRgb = hexRgb(L.bg);
  Object.assign(palette, {
    text: L.text, text2: L.text2, text3: L.text3, line: L.line, line2: L.line2, accent: r.accent, bg: L.bg,
    classes: [r.trails.wander, r.trails.berg, r.trails.alpin, L.text3],
    gl: r.gl,
    accentTint: rgba(accentRgb.map((c, i) => Math.round(c * 0.45 + textRgb[i] * 0.55)) as RGB, 1),
  });
  return r;
}
