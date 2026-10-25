# HIKA · Swiss trail console

A sci-fi HUD for exploring Swiss hiking routes, built entirely on swisstopo open data. The first
region is the **Alpstein** (Säntis, Seealpsee, Hoher Kasten): the whole signposted trail network
in 3D, every SchweizMobil route that crosses it, and a few classic hikes routed on the trail graph.

The look comes from two projects; see [Credits](#credits).

## Run

Requires Node 24 and [Task](https://taskfile.dev/installation/).

```bash
task dev
```

`task` lists every command. Each one wraps an npm script in `package.json`, so `npm run <script>`
works too.

The generated Alpstein bundle is committed under `public/data/alpstein/`, so the app runs without
rebuilding data.

## Rebuild the data

```bash
task region REGION=alpstein
```

`task region:build` and `task region:check` run the two steps on their own.

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
task check
```

This runs the type-checker and the unit tests (`task test` for the tests alone).

## Deploy

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on every push to `main`
(enable Pages → "GitHub Actions" in the repository settings).

## Credits

HIKA would not exist without two sci-fi console projects:

- **[beastydesign · Diagonale des Fous](https://beastydesign.github.io/scifi/)**: the original race
  console for La Réunion. Its point-cloud terrain, instrument panels and overall visual language are
  what this project set out to recreate for Switzerland. Its code is all rights reserved, so HIKA is
  an independent re-implementation and copies none of its code or assets.
- **[LosEcher · hud-console-framework](https://github.com/LosEcher/hud-console-framework)** (MIT):
  an open re-creation of that style with design tokens, a single accent colour and corner-bracket
  panels, which showed how to structure the look as reusable tokens.

## Data licence

Geodata © swisstopo, free to use with attribution (opendata.swiss terms "BY"). Routes ©
SchweizMobil / ASTRA. See `NOTICE.md`.
