import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, hexRgb, resolve, STYLES, THEMES, type Display, type RGB, type Scheme, type StyleId, type ThemeId } from '../src/theme/tokens';

/** WCAG 2 relative luminance. */
function luminance([r, g, b]: RGB) {
  const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
const contrast = (a: RGB, b: RGB) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** A colour as seen over `under`: rgba() alpha is composited, hex is opaque. */
function over(c: string, under: RGB): RGB {
  const a = Number(c.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/)?.[1] ?? 1), rgb = hexRgb(c);
  return rgb.map((v, i) => Math.round(v * a + under[i] * (1 - a))) as RGB;
}

const all: Display[] = [];
for (const theme of Object.keys(THEMES) as ThemeId[])
  for (const style of Object.keys(STYLES) as StyleId[])
    for (const scheme of ['dark', 'light'] as Scheme[]) all.push({ theme, style, scheme });

describe('display tokens', () => {
  it('defaults to cinder · paperlab · dark, which wears the paperlab accent', () => {
    expect(DEFAULT_DISPLAY).toEqual({ theme: 'cinder', style: 'paperlab', scheme: 'dark' });
    const r = resolve(DEFAULT_DISPLAY);
    expect(r.accent).toBe('#c8746a');
    expect(r.ladder.bg).toBe('#0c0c0c');
  });

  it('lets the theme accent through only for styles without their own', () => {
    expect(resolve({ theme: 'hika', style: 'phosphor', scheme: 'dark' }).accent).toBe('#f2c230');
    expect(resolve({ theme: 'cinder', style: 'phosphor', scheme: 'dark' }).ladder.bg).toBe('#040303');
    expect(resolve({ theme: 'hika', style: 'paperlab', scheme: 'dark' }).accent).toBe('#c8746a');
  });

  it.each(all.map((d) => [`${d.theme} · ${d.style} · ${d.scheme}`, d] as const))('%s keeps readable contrast', (_, d) => {
    const { ladder: L, accent, accentTint, trails } = resolve(d);
    const bg = hexRgb(L.bg), panel = over(L.panel, bg);
    // Map labels sit on a halo of the background colour, as trail lines sit on their casing.
    for (const t of [L.text, accentTint]) expect(contrast(hexRgb(t), bg)).toBeGreaterThanOrEqual(7);
    for (const t of [L.text2, accent]) expect(contrast(hexRgb(t), bg)).toBeGreaterThanOrEqual(4.5);
    for (const surface of [bg, panel]) {
      expect(contrast(hexRgb(L.text), surface)).toBeGreaterThanOrEqual(7);
      expect(contrast(hexRgb(L.text2), surface)).toBeGreaterThanOrEqual(4.5);
      // Tertiary text is for axis ticks and hints; HIKA's original phosphor dark sits at 2.8.
      expect(contrast(hexRgb(L.text3), surface)).toBeGreaterThanOrEqual(2.5);
      expect(contrast(hexRgb(accent), surface)).toBeGreaterThanOrEqual(3);
      for (const t of [trails.wander, trails.berg, trails.alpin]) expect(contrast(hexRgb(t), surface)).toBeGreaterThanOrEqual(3);
    }
  });
});
