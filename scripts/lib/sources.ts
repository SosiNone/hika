import type { Source } from '../../src/data/types';

/** swisstopo's terms for its free geodata (OGD): any use, credit "©swisstopo". */
const SWISSTOPO_OGD = 'https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices';

/**
 * The open data the atlas is built from, credited in its manifest, the app's footer and NOTICE.md.
 * Each links to the dataset, as opendata.swiss's "open use, must provide the source" terms ask.
 */
export const SOURCES: Source[] = [
  { name: 'swissALTI3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/height-model-swissalti3d', terms: SWISSTOPO_OGD },
  { name: 'swissTLM3D Wanderwege', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d', terms: SWISSTOPO_OGD },
  { name: 'swissNAMES3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swissnames3d', terms: SWISSTOPO_OGD },
  { name: 'swissBOUNDARIES3D', owner: 'swisstopo', url: 'https://www.swisstopo.admin.ch/en/landscape-model-swissboundaries3d', terms: SWISSTOPO_OGD },
  {
    name: 'Wanderland Schweiz', owner: 'Federal Roads Office FEDRO, SchweizMobil and the cantons',
    url: 'https://data.geo.admin.ch/browser/index.html#/collections/ch.astra.wanderland', terms: 'https://opendata.swiss/en/terms-of-use/#terms_by',
  },
  {
    name: 'Profile service (swissALTI3D DTM2)', owner: 'swisstopo, geo.admin.ch',
    url: 'https://api3.geo.admin.ch/services/sdiservices.html#profile', terms: 'https://www.geo.admin.ch/en/general-terms-of-use-fsdi',
  },
];
