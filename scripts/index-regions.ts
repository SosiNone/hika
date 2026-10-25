/**
 * Rewrites public/data/regions.json from the built bundles: `npm run index:regions`.
 * build-region does this on its own; run it after deleting a bundle or changing a `defaultRoute`.
 */
import { INDEX_FILE, writeRegionIndex } from './lib/regions';

const { regions } = writeRegionIndex();
console.log(`wrote ${INDEX_FILE}: ${regions.map((r) => r.id).join(', ')}`);
