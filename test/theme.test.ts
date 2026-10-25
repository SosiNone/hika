import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, hexRgb, isScheme, resolve, SCHEMES, type RGB, type Scheme } from '../src/theme/tokens';

/** WCAG 2 relative luminance. */
function luminance([r, g, b]: RGB) {
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
const contrast = (a: RGB, b: RGB) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const linear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** OKLab distance ×100 between two colours, optionally as seen through a linear-RGB vision matrix. */
function distance(a: RGB, b: RGB, vision?: number[][]) {
  const lab = (c: RGB) => {
    let [r, g, bl] = c.map(linear);
    if (vision) [r, g, bl] = vision.map((m) => Math.min(1, Math.max(0, m[0] * r + m[1] * g + m[2] * bl)));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}
/** Machado et al. (2009) simulations at full severity: the two common red-green deficiencies. */
const DEUTAN = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]];
const PROTAN = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]];

describe('display tokens', () => {
  it('defaults to the dark scheme with the glacier accent', () => {
    expect(DEFAULT_DISPLAY).toEqual({ scheme: 'dark' });
    const r = resolve(DEFAULT_DISPLAY);
    expect(r.accent).toBe('#40ccd0');
    expect(r.ladder.bg).toBe('#0c0c0c');
  });

  // The selected route wears the accent on top of the trail network, so it must never read as a trail class.
  it.each(Object.keys(SCHEMES) as Scheme[])('%s accent stays clear of the trail-class colours', (scheme) => {
    const { accent, trails } = resolve({ scheme });
    for (const t of [trails.wander, trails.berg, trails.alpin]) {
      expect(distance(hexRgb(accent), hexRgb(t))).toBeGreaterThanOrEqual(15);
      for (const vision of [DEUTAN, PROTAN]) expect(distance(hexRgb(accent), hexRgb(t), vision)).toBeGreaterThanOrEqual(8);
    }
  });

  it('accepts only the dark and light schemes', () => {
    expect(['dark', 'light'].every(isScheme)).toBe(true);
    for (const s of ['phosphor', 'paperlab', '', null, undefined]) expect(isScheme(s)).toBe(false);
  });

  it.each(Object.keys(SCHEMES) as Scheme[])('%s keeps readable contrast', (scheme) => {
    const { ladder: L, accent, accentTint, trails } = resolve({ scheme });
    const bg = hexRgb(L.bg);
    // Map labels are read against the background showing between the points.
    for (const t of [L.text, accentTint]) expect(contrast(hexRgb(t), bg)).toBeGreaterThanOrEqual(7);
    for (const t of [L.text2, accent]) expect(contrast(hexRgb(t), bg)).toBeGreaterThanOrEqual(4.5);
    for (const surface of [bg, hexRgb(L.panel)]) {
      expect(contrast(hexRgb(L.text), surface)).toBeGreaterThanOrEqual(7);
      // Tertiary text is for axis ticks and hints.
      for (const t of [L.text2, L.text3]) expect(contrast(hexRgb(t), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hexRgb(accent), surface)).toBeGreaterThanOrEqual(3);
      for (const t of [trails.wander, trails.berg, trails.alpin]) expect(contrast(hexRgb(t), surface)).toBeGreaterThanOrEqual(3);
    }
  });
});
