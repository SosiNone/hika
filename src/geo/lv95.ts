/**
 * LV95 (EPSG:2056) <-> WGS84 with the swisstopo approximate formulas
 * ("Formeln und Konstanten für die Berechnung der Schweizerischen schiefachsigen
 * Zylinderprojektion"), accurate to about 1 m inside Switzerland.
 */
export function lv95ToWgs84(e: number, n: number): [lon: number, lat: number] {
  const y = (e - 2_600_000) / 1e6, x = (n - 1_200_000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  return [(lon * 100) / 36, (lat * 100) / 36];
}

export function wgs84ToLv95(lon: number, lat: number): [e: number, n: number] {
  const p = (lat * 3600 - 169_028.66) / 10_000, l = (lon * 3600 - 26_782.5) / 10_000;
  const e = 2_600_072.37 + 211_455.93 * l - 10_938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
  const n = 1_200_147.07 + 308_807.95 * p + 3_745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
  return [e, n];
}
