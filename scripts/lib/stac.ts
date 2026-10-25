import type { BBox } from '../../src/data/types';
import { lv95ToWgs84 } from '../../src/geo/lv95';
import { fetchJson } from './http';

const STAC = 'https://data.geo.admin.ch/api/stac/v1';

export interface StacAsset { href: string; type: string; gsd?: number }
export interface StacItem { id: string; bbox: number[]; properties: { datetime: string }; assets: Record<string, StacAsset> }
interface StacPage { features: StacItem[]; links: { rel: string; href: string }[] }

/** WGS84 bbox that encloses an LV95 bbox (the projection's grid is slightly rotated). */
export function wgs84Bounds([minE, minN, maxE, maxN]: BBox): [number, number, number, number] {
  const corners = [lv95ToWgs84(minE, minN), lv95ToWgs84(minE, maxN), lv95ToWgs84(maxE, minN), lv95ToWgs84(maxE, maxN)];
  const lons = corners.map((c) => c[0]), lats = corners.map((c) => c[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** All items of `collection` intersecting `bbox`, following pagination. */
export async function stacItems(collection: string, bbox?: BBox): Promise<StacItem[]> {
  const q = bbox ? `&bbox=${wgs84Bounds(bbox).map((v) => v.toFixed(5)).join(',')}` : '';
  let url: string | undefined = `${STAC}/collections/${collection}/items?limit=100${q}`;
  const items: StacItem[] = [];
  while (url) {
    const page: StacPage = await fetchJson<StacPage>(url);
    items.push(...page.features);
    url = page.links.find((l) => l.rel === 'next')?.href;
  }
  return items;
}

/** The newest item of a collection, e.g. the latest yearly swissNAMES3D release. */
export async function latestItem(collection: string): Promise<StacItem> {
  const items = await stacItems(collection);
  return items.sort((a, b) => b.properties.datetime.localeCompare(a.properties.datetime))[0];
}
