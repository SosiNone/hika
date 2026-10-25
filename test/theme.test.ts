import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, hexRgb, isScheme, resolve, SCHEMES, type RGB, type Scheme } from '../src/theme/tokens';

/** WCAG 2 relative luminance. */
function luminance([r, g, b]: RGB) {
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
const contrast = (a: RGB, b: RGB) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('display tokens', () => {
  it('defaults to the dark scheme with the paperlab brick accent', () => {
    expect(DEFAULT_DISPLAY).toEqual({ scheme: 'dark' });
    const r = resolve(DEFAULT_DISPLAY);
    expect(r.accent).toBe('#c8746a');
    expect(r.ladder.bg).toBe('#0c0c0c');
  });

  it('accepts only the dark and light schemes', () => {
    expect(['dark', 'light'].every(isScheme)).toBe(true);
    for (const s of ['phosphor', 'paperlab', '', null, undefined]) expect(isScheme(s)).toBe(false);
  });

  it.each(Object.keys(SCHEMES) as Scheme[])('%s keeps readable contrast', (scheme) => {
    const { ladder: L, accent, accentTint, trails } = resolve({ scheme });
    const bg = hexRgb(L.bg);
    // Map labels sit on a halo of the background colour, as trail lines sit on their casing.
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
