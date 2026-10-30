import type { Source } from '../../src/data/types';

/** The open data a bundle or the atlas is built from, credited in the files themselves. */
export const SOURCES: Source[] = [
  { name: 'swissALTI3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/height-model-swissalti3d' },
  { name: 'swissTLM3D Wanderwege', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d' },
  { name: 'swissNAMES3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swissnames3d' },
  { name: 'swissBOUNDARIES3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swissboundaries3d' },
  { name: 'Wanderland Schweiz', owner: 'SchweizMobil / ASTRA', url: 'https://www.schweizmobil.ch/en/hiking-in-switzerland' },
  { name: 'Profile service (DTM2)', owner: 'geo.admin.ch', url: 'https://api3.geo.admin.ch/services/sdiservices.html#profile' },
];
