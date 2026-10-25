/**
 * Display tokens. HIKA has one visual language, "paperlab" (flat greys and a single brick accent,
 * from LosEcher/hud-console-framework (MIT), which credits the @mika_systems Paper Lab demo), in a
 * dark and a light scheme. Pure data and helpers, no DOM: vitest imports this.
 */

export type RGB = [number, number, number];
export type Scheme = 'dark' | 'light';
export interface Display { scheme: Scheme }

export const DEFAULT_DISPLAY: Display = { scheme: 'dark' };

/** Surfaces and text, mapped onto HIKA's CSS variables. */
export interface Ladder {
  bg: string; bg2: string; panel: string;
  line: string; line2: string; line3: string;
  text: string; text2: string; text3: string;
  danger: string;
}

/** Terrain view colours (linear 0–1). `blend: 'over'` is needed on light paper, where additive light washes out. */
export interface GlPalette {
  low: RGB; high: RGB; steep: RGB; contour: RGB; hover: RGB; flash: RGB;
  gain: number; blend: 'add' | 'over';
}

export const SCHEMES: Record<Scheme, { accent: string; ladder: Ladder; gl: GlPalette }> = {
  dark: {
    accent: '#c8746a',
    ladder: { bg: '#0c0c0c', bg2: '#171717', panel: '#171717', line: '#2e2e2e', line2: '#3a3a3a', line3: '#555555', text: '#e6e6e6', text2: '#b0b0b0', text3: '#909090', danger: '#ff5a4a' },
    gl: { low: [0.05, 0.05, 0.05], high: [0.86, 0.86, 0.86], steep: [0.22, 0.22, 0.22], contour: [0.8, 0.8, 0.8], hover: [1, 1, 1], flash: [1, 1, 1], gain: 1, blend: 'add' },
  },
  light: {
    accent: '#8f4238',
    ladder: { bg: '#f2f1ed', bg2: '#e9e8e3', panel: '#e9e8e3', line: '#c9c7c0', line2: '#b5b3ac', line3: '#8f8d86', text: '#16161a', text2: '#45433f', text3: '#5f5d58', danger: '#a8322a' },
    gl: { low: [0.66, 0.65, 0.62], high: [0.08, 0.08, 0.09], steep: [-0.2, -0.2, -0.2], contour: [0.2, 0.2, 0.2], hover: [0.09, 0.09, 0.1], flash: [0.09, 0.09, 0.1], gain: 0.55, blend: 'over' },
  },
};

/** Trail-class colours are semantic (Swiss signposts) and only adjusted for contrast per scheme. */
export const TRAILS: Record<Scheme, { wander: string; berg: string; alpin: string; stripe: string }> = {
  dark: { wander: '#f2c230', berg: '#ec4a4f', alpin: '#4a92f6', stripe: '#ffffff' },
  // White signpost stripes would vanish on paper; grey keeps the three-band pattern readable.
  light: { wander: '#9a7400', berg: '#c62f35', alpin: '#2a6fd6', stripe: '#a9a7a0' },
};

export interface Resolved {
  display: Display;
  /** CSS custom properties to set on :root. */
  css: Record<string, string>;
  ladder: Ladder;
  accent: string;
  /** The accent lifted towards the text colour, for emphasised labels on the terrain. */
  accentTint: string;
  trails: { wander: string; berg: string; alpin: string; stripe: string };
  gl: GlPalette & { clear: RGB; accent: RGB; trails: RGB[] };
}

export function resolve(d: Display): Resolved {
  const { accent, ladder, gl } = SCHEMES[d.scheme];
  const trails = TRAILS[d.scheme];
  const a = hexRgb(accent), bg = hexRgb(ladder.bg), text = hexRgb(ladder.text);
  const tint = a.map((c, i) => Math.round(c * 0.45 + text[i] * 0.55)) as RGB;
  const css: Record<string, string> = {
    '--bg': ladder.bg, '--bg-2': ladder.bg2, '--bg-rgb': a3(bg), '--panel': ladder.panel,
    '--line': ladder.line, '--line-2': ladder.line2, '--line-3': ladder.line3,
    '--text': ladder.text, '--text-2': ladder.text2, '--text-3': ladder.text3,
    '--accent': accent, '--accent-rgb': a3(a), '--accent-dim': `rgba(${a3(a)}, 0.16)`,
    '--wander': trails.wander, '--berg': trails.berg, '--alpin': trails.alpin, '--stripe': trails.stripe,
    '--danger': ladder.danger,
  };
  const lin = (c: RGB): RGB => [c[0] / 255, c[1] / 255, c[2] / 255];
  return {
    display: d, css, ladder, accent, accentTint: `rgb(${a3(tint)})`, trails,
    gl: { ...gl, clear: lin(bg), accent: lin(a), trails: [trails.wander, trails.berg, trails.alpin].map((c) => lin(hexRgb(c))) },
  };
}

/** Parses '#rrggbb' or 'rgb(a)(r, g, b, …)' into 0–255 channels. */
export function hexRgb(c: string): RGB {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) throw new Error(`not a colour: ${c}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const a3 = (c: RGB) => `${c[0]}, ${c[1]}, ${c[2]}`;

export const isScheme = (s: unknown): s is Scheme => s === 'dark' || s === 'light';
