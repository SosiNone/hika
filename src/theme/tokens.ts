/**
 * Display tokens: theme × style × scheme, after the layering of LosEcher/hud-console-framework
 * (MIT). A theme is an accent (and, for some, a background); a style is the visual language
 * (grey ladder, surfaces, terrain colours); a scheme is dark or light. A style that brings its
 * own accent overrides the theme's. Pure data and helpers, no DOM: vitest imports this.
 */

export type RGB = [number, number, number];
export type Scheme = 'dark' | 'light';
export type ThemeId = 'hika' | 'cinder' | 'orbital' | 'ember';
export type StyleId = 'paperlab' | 'phosphor';
export interface Display { theme: ThemeId; style: StyleId; scheme: Scheme }

export const DEFAULT_DISPLAY: Display = { theme: 'cinder', style: 'paperlab', scheme: 'dark' };

interface Accent { dark: string; light: string }

/** Accent sets. `bg` / `bg2` apply in the dark scheme of styles without their own accent. */
export const THEMES: Record<ThemeId, { accent: Accent; bg?: string; bg2?: string }> = {
  hika: { accent: { dark: '#f2c230', light: '#846600' } },
  cinder: { accent: { dark: '#ff4d3d', light: '#b0352b' }, bg: '#040303', bg2: '#120b08' },
  orbital: { accent: { dark: '#46d8ff', light: '#0a6a82' }, bg: '#020304', bg2: '#071014' },
  ember: { accent: { dark: '#ff9a3c', light: '#9a5200' } },
};

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

interface StyleScheme { ladder: Ladder; gl: GlPalette }

export const STYLES: Record<StyleId, { accent: Accent | null; dark: StyleScheme; light: StyleScheme }> = {
  // Flat greyscale "paper lab" language (from the @mika_systems Paper Lab demo, via hud-console-framework).
  paperlab: {
    accent: { dark: '#c8746a', light: '#8f4238' },
    dark: {
      ladder: { bg: '#0c0c0c', bg2: '#171717', panel: '#171717', line: '#2e2e2e', line2: '#3a3a3a', line3: '#555555', text: '#e6e6e6', text2: '#b0b0b0', text3: '#909090', danger: '#ff5a4a' },
      gl: { low: [0.05, 0.05, 0.05], high: [0.86, 0.86, 0.86], steep: [0.22, 0.22, 0.22], contour: [0.8, 0.8, 0.8], hover: [1, 1, 1], flash: [1, 1, 1], gain: 1, blend: 'add' },
    },
    light: {
      ladder: { bg: '#f2f1ed', bg2: '#e9e8e3', panel: '#e9e8e3', line: '#c9c7c0', line2: '#b5b3ac', line3: '#8f8d86', text: '#16161a', text2: '#45433f', text3: '#5f5d58', danger: '#a8322a' },
      gl: { low: [0.66, 0.65, 0.62], high: [0.08, 0.08, 0.09], steep: [-0.2, -0.2, -0.2], contour: [0.2, 0.2, 0.2], hover: [0.09, 0.09, 0.1], flash: [0.09, 0.09, 0.1], gain: 0.55, blend: 'over' },
    },
  },
  // HIKA's original hologram look: teal-tinted alpha ladder, teal point cloud, the theme's accent.
  phosphor: {
    accent: null,
    dark: {
      ladder: { bg: '#060809', bg2: '#0a0d0e', panel: 'rgba(10, 13, 14, 0.82)', line: 'rgba(214, 232, 226, 0.1)', line2: 'rgba(214, 232, 226, 0.2)', line3: 'rgba(214, 232, 226, 0.42)', text: '#d6e2de', text2: '#8b9894', text3: '#4f5a57', danger: '#ff5a4a' },
      gl: { low: [0.05, 0.26, 0.27], high: [0.62, 1, 0.86], steep: [0.2, 0.35, 0.3], contour: [0.55, 0.95, 0.82], hover: [1, 1, 1], flash: [1, 1, 1], gain: 1, blend: 'add' },
    },
    light: {
      ladder: { bg: '#eef1f0', bg2: '#e3e8e6', panel: 'rgba(248, 250, 249, 0.86)', line: 'rgba(16, 40, 34, 0.12)', line2: 'rgba(16, 40, 34, 0.22)', line3: 'rgba(16, 40, 34, 0.45)', text: '#121a18', text2: '#45524e', text3: '#5f6b67', danger: '#b8322a' },
      gl: { low: [0.6, 0.72, 0.7], high: [0.02, 0.22, 0.2], steep: [-0.15, -0.1, -0.1], contour: [0.05, 0.35, 0.3], hover: [0.07, 0.1, 0.09], flash: [0.07, 0.1, 0.09], gain: 0.55, blend: 'over' },
    },
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

/** Resolves a display in the framework's order: style tokens, then the theme's accent/bg where the style has none. */
export function resolve(d: Display): Resolved {
  const theme = THEMES[d.theme], style = STYLES[d.style], s = style[d.scheme];
  const ladder = { ...s.ladder };
  if (!style.accent && d.scheme === 'dark') {
    if (theme.bg) ladder.bg = theme.bg;
    if (theme.bg2) ladder.bg2 = theme.bg2;
  }
  const accent = (style.accent ?? theme.accent)[d.scheme];
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
    gl: { ...s.gl, clear: lin(bg), accent: lin(a), trails: [trails.wander, trails.berg, trails.alpin].map((c) => lin(hexRgb(c))) },
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

export function isDisplay(d: Partial<Display>): d is Display {
  return !!d.theme && d.theme in THEMES && !!d.style && d.style in STYLES && (d.scheme === 'dark' || d.scheme === 'light');
}
