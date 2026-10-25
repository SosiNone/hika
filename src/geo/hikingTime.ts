/**
 * Swiss hiking time ("Wanderzeit"), the times on the yellow signposts.
 *
 * Schweizer Wanderwege computes signpost times from horizontal distance and slope, t = L · f(S),
 * calibrated to 4.2 km/h on the flat. The coefficients of their polynomial are not published, so
 * PACE is digitised from the official isochrone chart ("Zeitberechnungsdiagramm", © 1986
 * Schweizer Wanderwege, reproduced in ASTRA Vollzugshilfe Langsamverkehr Nr. 6 "Signalisation
 * Wanderwege", 2008, p. 66): minutes per horizontal km for slopes −40 % … +40 % in 0.5 % steps.
 * The handbook leaves slopes beyond ±40 % to field experience; we extrapolate linearly and flag them.
 */
const PACE = [
  36.19, 35.75, 35.32, 34.88, 34.45, 34.01, 33.57, 33.13, 32.69, 32.25, 31.81, 31.38, 30.94,
  30.51, 30.08, 29.65, 29.21, 28.79, 28.36, 27.94, 27.52, 27.10, 26.68, 26.26, 25.85, 25.44,
  25.05, 24.65, 24.25, 23.86, 23.47, 23.08, 22.70, 22.32, 21.94, 21.56, 21.19, 20.82, 20.47,
  20.11, 19.76, 19.42, 19.09, 18.76, 18.43, 18.11, 17.80, 17.50, 17.20, 16.90, 16.62, 16.33,
  16.06, 15.79, 15.53, 15.28, 15.04, 14.80, 14.58, 14.38, 14.18, 14.01, 13.85, 13.70, 13.57,
  13.47, 13.38, 13.31, 13.27, 13.24, 13.23, 13.25, 13.29, 13.35, 13.42, 13.52, 13.64, 13.77,
  13.92, 14.08, 14.26, 14.45, 14.66, 14.87, 15.09, 15.33, 15.57, 15.82, 16.08, 16.35, 16.62,
  16.91, 17.20, 17.50, 17.82, 18.15, 18.49, 18.84, 19.21, 19.60, 20.00, 20.43, 20.87, 21.34,
  21.83, 22.34, 22.87, 23.43, 24.01, 24.61, 25.23, 25.88, 26.54, 27.23, 27.93, 28.64, 29.37,
  30.11, 30.86, 31.62, 32.39, 33.16, 33.94, 34.72, 35.51, 36.31, 37.11, 37.91, 38.71, 39.52,
  40.33, 41.15, 41.98, 42.82, 43.66, 44.52, 45.38, 46.26, 47.14, 48.03, 48.92, 49.81, 50.72,
  51.63, 52.53, 53.44, 54.36, 55.27, 56.19, 57.10, 58.02, 58.92, 59.83, 60.75, 61.71, 62.66,
  63.59, 64.52, 65.45, 66.37, 67.28
];
const STEP = 0.5;
const MIN_SLOPE = -40;
export const MAX_SLOPE = 40;

/** Minutes per horizontal kilometre at the given slope (percent, positive = uphill). */
export function paceMinPerKm(slopePct: number): number {
  const x = (slopePct - MIN_SLOPE) / STEP;
  const i = Math.min(Math.max(Math.floor(x), 0), PACE.length - 2);
  return PACE[i] + (PACE[i + 1] - PACE[i]) * (x - i);
}

/** Minutes to cover `horizontalM` metres while climbing `dz` metres (negative = descent). */
export function segmentMinutes(horizontalM: number, dz: number): number {
  if (horizontalM <= 0) return 0;
  return (horizontalM / 1000) * paceMinPerKm((dz / horizontalM) * 100);
}

/**
 * Cumulative minutes along a track of evenly spaced samples. Slope is taken from altitudes
 * smoothed over `windowM`, because 2 m terrain noise on 10 m steps would inflate the time.
 */
export function cumulativeMinutes(alt: ArrayLike<number>, stepM: number, windowM = 60): Float64Array {
  const smooth = smoothAltitudes(alt, Math.max(1, Math.round(windowM / stepM / 2)));
  const out = new Float64Array(alt.length);
  for (let i = 1; i < alt.length; i++) out[i] = out[i - 1] + segmentMinutes(stepM, smooth[i] - smooth[i - 1]);
  return out;
}

export function smoothAltitudes(alt: ArrayLike<number>, radius: number): Float64Array {
  const out = new Float64Array(alt.length);
  for (let i = 0; i < alt.length; i++) {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(alt.length - 1, i + radius); k++) { sum += alt[k]; n++; }
    out[i] = sum / n;
  }
  return out;
}

/** Signposts show times rounded to the nearest 5 minutes. */
export const signpostMinutes = (min: number) => Math.max(5, Math.round(min / 5) * 5);

export function formatDuration(min: number, signpost = false): string {
  const m = signpost ? signpostMinutes(min) : Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
