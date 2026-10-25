# HIKA · Swiss trail console

A sci-fi HUD for exploring Swiss hiking routes, built entirely on swisstopo open data. The first
region is the **Alpstein** (Säntis, Seealpsee, Hoher Kasten): the whole signposted trail network
in 3D, every SchweizMobil route that crosses it, and a few classic hikes routed on the trail graph.

Visual language inspired by [beastydesign.github.io/scifi](https://beastydesign.github.io/scifi/)
(no code reused) and the MIT [hud-console-framework](https://github.com/LosEcher/hud-console-framework).

## Run

```bash
npm install
npm run dev
```

The generated Alpstein bundle is committed under `public/data/alpstein/`, so the app runs without
rebuilding data.

## Rebuild the data

```bash
npm run build:region alpstein
npm run check:region alpstein
```

`regions/<id>.json` defines a region: LV95 bbox, grid cell, curated hikes (waypoint names resolved
through swissNAMES3D) and routes to exclude. The pipeline caches downloads in `.cache/` (about
300 MB on first run, mostly the national trail and names datasets) and takes about 30 s afterwards.

| Step | Source | Output |
|---|---|---|
| Terrain | swissALTI3D 2 m COGs via STAC, box-averaged from the 4 m overview | `terrain.u16` (decimetres, row 0 = north) |
| Colour | SWISSIMAGE WMTS, 10 m/px | `ortho.jpg` |
| Trails | swissTLM3D Wanderwege GeoPackage (class, surface) | `trails.bin` |
| Places | swissNAMES3D (summits, passes, inns, stops, lakes …) | `region.json` |
| Routes | SchweizMobil "Wanderland" layer (identify + find), chained and clipped | `region.json` |
| Classics | Dijkstra on the trail graph, weighted by Swiss hiking time | `region.json` |
| Heights | geo.admin.ch profile service (DTM2) every 10 m | `region.json` |
| Locator | profile-service rows over CH + swissBOUNDARIES3D | `switzerland.u16`, `region.json` |

## Hiking time

Times follow the Schweizer Wanderwege signpost method (4.2 km/h on the flat, slope-dependent pace).
Its polynomial coefficients are not published, so `src/geo/hikingTime.ts` carries a pace table
digitised from the official isochrone chart (ASTRA *Signalisation Wanderwege*, 2008, p. 66).
Signpost-style times are rounded to 5 minutes.

## Tests

```bash
npm test
```

## Deploy

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on every push to `main`
(enable Pages → "GitHub Actions" in the repository settings).

## Data licence

Geodata © swisstopo, free to use with attribution (opendata.swiss terms "BY"). Routes ©
SchweizMobil / ASTRA. See `NOTICE.md`.
