# Data coverage

What data HIKA has, and how much of it the app shows. Use it to plan features: a ✗ or ◐ row in
section 1 needs only app work, section 2 needs a pipeline change, and section 3 needs a new source.

Counts are from v0.2.0 and the Alpstein region. Since v0.14 the data is the atlas (AGENTS.md): national
tiles, whole routes and a catalogue, which the app reads one window at a time. When you add an atlas
field, a panel or a source, update the matching row.

**Legend:** ✅ shown · ◐ partly shown · ✗ in the atlas but not shown

## 1. In the atlas

### Terrain and imagery

| Data | Source | Atlas | Shown | Where | Unused / ideas |
|---|---|---|---|---|---|
| Height grid, 20 m (5 km tiles, stitched into windows) | swissALTI3D | `terrain/<key>.bin` | ✅ | Point cloud, contours (worker), trail draping, slope aspect rose (I) | No height or slope readout under the cursor; no slope shading of the cloud |
| No-data cells beyond the border (`0`) | swissALTI3D (Switzerland only) | `terrain.bin` | ◐ | Left empty: no points or contours (Zermatt, Aletsch) | The Italian side of the Matterhorn is blank; a coarse foreign DEM could fill it |
| Area relief, 100 m (each area plus 4 km) | swissALTI3D, averaged from the 20 m tiles (`coarseGrid`) | `relief/<id>.bin`, `manifest.relief` | ✅ | Point cloud and contours around the window, cross-fading with it; the home view (double-click) shows all of it | No place labels or trails beyond the window |
| Grid min / max altitude | swissALTI3D | `grid.minAlt`, `grid.maxAlt` | ◐ | Exaggeration base, hiker drop line | Not shown as numbers |
| National relief, 2 km | Profile service (DTM2) | `switzerland.u16` | ✅ | Locator (G) and region browser, which drape the borders and the ranges and areas on it | — |
| National relief, 1 km | swissALTI3D, averaged from the partition's 200 m terrain model | `switzerland-1km.u16` (`locator.detail`) | ✅ | Region browser, fetched when it opens: the relief it zooms into a range on | — |
| National border, canton borders | swissBOUNDARIES3D | `locator.border`, `locator.cantons` | ✅ | Locator (G), region browser | Canton borders are not drawn on the 3D terrain (the region spans AI, AR and SG) |
| Lakes | Derived in the app from the flat cells of `switzerland.u16` (`lakeCells`) | — | ✅ | Locator (G), region browser | At 2 km cells only the larger lakes show (two or more flat cells); no lake names |
| Mountain ranges and areas: outlines, shared borders | swissNAMES3D (Grossregion, Landschaftsname, Haupttal, Huegelzug, Massiv polygons), grown over the terrain by hiking time (`scripts/lib/partition.ts`) | `regions.json` `ranges`, `regions[].rings`, `arcs` | ✅ | Locator (G) and region browser: a range glows under the pointer, the browser zooms into it, the current area is lit. 3D terrain: the current area's border is draped on it, and the ground beyond recedes | — |

### Trail network

| Data | Source | Atlas | Shown | Where | Unused / ideas |
|---|---|---|---|---|---|
| Geometry of every signposted trail (6159 lines in Alpstein) | swissTLM3D Wanderwege | `trails/<key>.bin` | ✅ | 3D network with casing; in TRAILS AUTO only the trails within walking reach of the selected route | Not clickable: clicking selects routes only |
| Class per line (Wanderweg / Berg / Alpin) | swissTLM3D Wanderwege | `trails.bin` | ✅ | Network colour | — |
| Hard surface per line | swissTLM3D Wanderwege | `trails.bin` | ✗ | Decoded on load, never drawn | Dashed or dimmed asphalt on the map |
| Network km per class, hard km | derived | `trails.km`, `trails.hardKm` | ✅ | Trail class (C): network total and ghost markers | — |

### Places (swissNAMES3D)

The Alpstein box holds 1105 places (`places/<key>.json`). `LabelLayer` labels only some of them on the map; any place can also
appear as a route waypoint (panel B, profile ticks, trail log, footer ticker).

| Kind | In Alpstein | Map label | Waypoint | Unused / ideas |
|---|---|---|---|---|
| summit | 101 | ◐ prio ≥ 60 (Gipfel and above) | ✅ | Haupthügel, Hügel and Felskopf are never labelled |
| pass | 24 | ◐ prio ≥ 60 (not Strassenpass) | ✅ | |
| lake | 12 | ✅ | ✅ | |
| view | 3 | ✅ | ✅ | |
| stop | 169 | ◐ rail only (prio ≥ 45) | ✅ | 153 bus stops are not labelled. Useful for "where can I start / end" |
| inn (Gasthof abgelegen, Schutzhütte) | 57 | ✗ threshold 99 | ✅ | Huts and inns on the map |
| lift | 20 | ✗ threshold 99 | ✅ | Lifts as start points; see LIN lines in section 2 |
| village | 680 | ✗ | ◐ prio ≥ 30 | |
| water (waterfall), cave | 6 | ✗ | ✅ | |
| ridge | 33 | ✗ | ✗ | Shown nowhere: no label threshold, no waypoint reach |
| Place altitude | all | ◐ summits and passes only | ✅ | |

### Routes

| Data | Field (`routes/<id>.bin`) | Shown | Where | Unused / ideas |
|---|---|---|---|---|
| Geometry, sampled every 10 m | `e`, `n` | ✅ | Selected and hover ribbons, click and hover picking on the map, LV95 coordinate column | No export (GPX) |
| Altitude per sample (DTM2) | `alt` | ✅ | Profile (E), sparklines, hiker | — |
| Trail class per sample | `cls` | ✅ | Selected and hover ribbons, profile and gradient tint (E, F), trail log events (J) | — |
| Surface per sample | `surf` | ✗ | — | Mark asphalt stretches on the profile or ribbon; log "on asphalt for 2 km" |
| Number, name, from, to, category | `number` … `category` | ✅ | Route list (D), tickers, stage title | — |
| Source (SchweizMobil / curated) | `source` | ◐ | Implied by the "classic" group | — |
| Distance, climb, descent, time | `stats.km/up/down/time` | ✅ | Everywhere | — |
| Time in reverse | `stats.timeBack` | ✅ | ⇄ REV in the route player (A) walks the route to → from (`reverseRoute`, `&reverse=1` in the URL); top ticker "BACK" | — |
| Min / max altitude | `stats.minAlt/maxAlt` | ✅ | Terrain analysis (I), chart scales | — |
| Km per trail class, off network | `stats.classKm` | ✅ | Trail class (C) | — |
| Hard-surface km | `stats.hardKm` | ✅ | Trail class (C) | — |
| Km steeper than ±40 % | `stats.steepKm` | ✗ | — | Panel I recomputes a "> 40 %" bin from `alt`; nothing tells the user the time model is extrapolated there |
| Waypoints (place, km, alt, time) | `waypoints` | ✅ | B, E, J, map labels, preview "next point", footer ticker | — |

### Range and area metadata

| Data | Field (`regions.json`, `manifest.json`) | Shown | Where | Unused / ideas |
|---|---|---|---|---|
| Area title, cantons | `title`, `cantons` | ✅ | Region button (brand line), region browser, stage head, classics group in the route list | — |
| Area subtitle | `subtitle` | ✅ | Region browser list; tooltip on the region button | — |
| Range of an area, range titles and official names in every language | `range`, `ranges[].title`, `ranges[].names` | ✅ | Brand line (area · range); region browser list, map labels and search; locator meta while a range is hovered | — |
| Official names of the outlines an area grew from, former ids | `names`, `aliases` | ◐ | Region browser search ("Conches" finds Goms); old `?region=` links | Not shown as text |
| Label point, extent, km² | `label`, `bbox`, `km2` | ◐ | Map labels and pulse, LV95 and WGS84 readouts, sunrise / sunset; `bbox` for windows and prefetch | Area size is not shown |
| Area facts: route count, curated hike count, trail km per class, hard km, altitude range | `routes`, `classics`, `trailKm`, `hardKm`, `alt` | ✅ | Region browser list (summed per range); trail class (C) | — |
| Range facts: areas, routes | `ranges[].areas`, `ranges[].routes` | ✅ | Region browser list and map plates, locator plate | — |
| Route catalogue: every route's meta, stats, bbox, sparkline and areas (home area first) | `catalogue.json` | ✅ | Which routes a page lists; route windows; the route search in the region browser | Search results don't show their sparkline |
| Source list, with dataset links and terms | `manifest.json` `sources` | ◐ | The footer credits and links ©swisstopo and Wanderland Schweiz © FEDRO, with LICENCES (`NOTICE.txt`) | An about panel could list all of them |
| Build time | `manifest.json` `generated` | ✗ | — | Data freshness ("trails as of …") |

### Derived in the app (not stored)

| Data | Computed in | Shown in |
|---|---|---|
| Cumulative minutes, climb, descent per sample | `deriveRoute` (`src/data/load.ts`) | Route player (A), profile (E), gradient (F), cumulative (H), log (J) |
| Slope classes, max slope over 100 m, current slope | `analyse` (`src/panels/right.ts`) | Terrain analysis (I), walked part and the hiker's class live |
| Slope aspect along the route | `analyse`, from `heightAt` | Terrain analysis (I) rose, walked part, the hiker's sector and walking direction live |
| Sunrise / sunset at the area's label point | `sunTimes` (`src/ui/chrome.ts`) | Top-bar clock |

## 2. Downloaded by the pipeline but dropped

Adding any of these means a pipeline change plus an atlas format change (`types.ts` and
`ATLAS_FORMAT`, and for the tiles or route files the encoder and decoder in
`src/data/codec.ts`).

| Dataset | Kept | Dropped | Feature ideas |
|---|---|---|---|
| swissALTI3D | 4 m overview, box-averaged to a 20 m grid | The 2 m full resolution | Finer grid for small regions or a detail tile around the selected route |
| swissTLM3D Wanderwege: `objektart` | — | Path width / type: 2 m Weg 1904, 1 m Weg 1640, 3 m Strasse 1368, Markierte Spur 192, … (Alpstein line counts) | Show "marked track" vs road; filter out road stretches |
| swissTLM3D Wanderwege: `kunstbaute` | — | Brücke 341, Treppe 27, Furt 20, Tunnel 3, Galerie 1, … | Bridges, stairs and fords as route events in the trail log |
| swissTLM3D Wanderwege: `verkehrsbeschraenkung` | — | **Gesicherte Kletterpartie 7** (secured climbing sections), general restrictions 50 | Flag secured sections on routes: very relevant for Lisengrat-style hikes |
| swissTLM3D Wanderwege: names, change dates | — | `name`, `strassenname`, `revision_jahr`, … | Trail names in tooltips; data age |
| swissTLM3D Wanderwege: vertex heights | Parsed as XYZ | Z is discarded; the app drapes trails on the 20 m grid | Exact 3D trail heights |
| swissNAMES3D points (`_PKT.csv`) | 14 object types plus inns and villages | Flurname 2832, Lokalname 89, Kapelle 7, Quelle 2, Felsblock 2, Erratischer Block 1, … | Alp and field names at close zoom; springs as water sources |
| swissNAMES3D polygons (`_PLY.csv`) | See, Grat (label points) | Graben 77, Gebiet 57, Tal 4, Gletscher 2, Campingplatzareal 5, Öffentliches Parkplatzareal 2, … | Parking at trailheads |
| swissNAMES3D polygons (GeoPackage, 2026 release on) | The outlines of Grossregion (the ranges), Landschaftsname, Haupttal, Huegelzug and Massiv, with every language's name: they seed the areas | Every other polygon type; the outlines themselves (only the areas grown from them are stored) | Massif and valley names on the zoomed map |
| swissNAMES3D lines (`_LIN.csv`) | Not read | Fliessgewässer 113, Skilift 14, Luftseilbahn 6, Sesselbahn 3, Gondelbahn 2 | Draw cable cars (Ebenalp, Säntis, Hoher Kasten) as lines; streams |
| swissBOUNDARIES3D | National and canton outlines, simplified to 400 m | `tlm_bezirksgebiet`, `tlm_hoheitsgebiet` (districts, municipalities), full-detail rings, Liechtenstein | Canton and municipality borders on the terrain |
| Wanderland Schweiz (`ch.astra.wanderland` GeoPackage) | Every stage's number, name, ends and geometry | The 26 routes mostly abroad; per-route difficulty (`KonditionE`, `TechnikE`), the official times (`ZeitStZiE`) and the `Weg` segments with their surface | Show SchweizMobil's difficulty grades; compare their times with ours |
| Profile service | `DTM2` | `DTM25`, `COMB` | None: DTM2 is the finest model |

## 3. Not used yet

Open geo.admin.ch datasets that fit the product. The layer ids were checked against the API, the
WMTS capabilities or STAC in October 2026. The app never calls geo.admin.ch at runtime, so all of
them would be baked into the atlas at build time.

| Dataset | Layer / collection id | Feature ideas | Caveat |
|---|---|---|---|
| Trail closures and diversions | `ch.astra.wanderland-sperrungen_umleitungen` | Warn on closed route segments | Changes often; a build-time snapshot goes stale quickly |
| Public transport stops | `ch.bav.haltestellen-oev` | Reliable trailhead stops by mode | Timetables are not on geo.admin.ch |
| Wildlife rest zones | `ch.bafu.wrz-wildruhezonen_portal` | Area overlay; route warnings | Mostly winter restrictions |
| Federal hunting ban areas | `ch.bafu.bundesinventare-jagdbanngebiete` | Protected area overlay | |
| Parks of national importance | `ch.bafu.schutzgebiete-paerke_nationaler_bedeutung_perimeter` | Area overlay; seeds for areas | |
| swissTLM3D (full model) | `ch.swisstopo.swisstlm3d` (STAC) | Land cover (forest, rock, scree, glacier) to tint the point cloud; waters; cableway lines; buildings | Large download |
| swissSURFACE3D raster | `ch.swisstopo.swisssurface3d-raster` (STAC) | Surface minus terrain gives forest height: forest vs open ground along a route | Large download |
| swissBUILDINGS3D 3.0 | `ch.swisstopo.swissbuildings3d_3_0` (STAC) | Huts and summit buildings in 3D | |
| Slopes over 30° | `ch.swisstopo.hangneigung-ueber_30` (WMTS) | Steep-terrain overlay | Can also be computed from `terrain.bin` with no new data |
| Relief shading | `ch.swisstopo.swissalti3d-reliefschattierung` (WMTS) | Hillshade texture for the light scheme | Can also be computed from `terrain.bin` |
| National map | `ch.swisstopo.pixelkarte-farbe` (WMTS) | A second colour mode next to MONO | |
| SWISSIMAGE orthophoto | `ch.swisstopo.swissimage` (WMTS) | Was a point colour mode until 0.12 | Dropped in 0.13: about 95 MB for all of Switzerland, for a mode few used |
| Snowshoe and ski touring routes | `ch.swisstopo-karto.schneeschuhrouten`, `ch.swisstopo-karto.skitouren` | Winter routes | Outside hiking scope; owner decision |
| Mountain bike routes | `ch.astra.mountainbikeland` | Shared trail segments | Outside hiking scope; owner decision |
