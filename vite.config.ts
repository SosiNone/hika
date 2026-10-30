/// <reference types="vitest/config" />
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** The published atlas: the hika-data repo's GitHub Pages site. */
const PUBLISHED_ATLAS = 'https://sosinone.github.io/hika-data/v3/';
/** An atlas built here with `task atlas:build`, which the dev server serves under /data/v3/. */
const LOCAL_ATLAS = resolve('.atlas/v3');
const TYPES: Record<string, string> = { '.json': 'application/json', '.bin': 'application/octet-stream', '.u16': 'application/octet-stream' };

/** Serves the local atlas in the dev server, so the app can run against a fresh build. */
function localAtlas(): Plugin {
  return {
    name: 'hika-local-atlas',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/data/v3', (req, res, next) => {
        const file = join(LOCAL_ATLAS, decodeURIComponent((req.url ?? '/').split('?')[0]));
        if (!file.startsWith(LOCAL_ATLAS + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * NOTICE.txt beside the site: HIKA's licence, the data credits and third-party notices (NOTICE.md),
 * and the licence of the font the site ships, which the SIL OFL asks to travel with it.
 */
function notices(): Plugin {
  const text = () => [
    readFileSync('LICENSE', 'utf8'),
    readFileSync('NOTICE.md', 'utf8'),
    `IBM Plex Mono\n\n${readFileSync('node_modules/@fontsource/ibm-plex-mono/LICENSE', 'utf8')}`,
  ].join('\n\n' + '-'.repeat(72) + '\n\n');
  return {
    name: 'hika-notices',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/NOTICE.txt', (_req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(text());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'NOTICE.txt', source: text() });
    },
  };
}

// GitHub Pages serves the site under /<repo>/; override with BASE=/ for a custom domain.
export default defineConfig(({ command }) => ({
  base: process.env.BASE ?? './',
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // DATA_URL overrides; otherwise the dev server prefers a local build of the atlas.
    __DATA_URL__: JSON.stringify(process.env.DATA_URL ?? (command === 'serve' && existsSync(join(LOCAL_ATLAS, 'manifest.json')) ? '/data/v3/' : PUBLISHED_ATLAS)),
  },
  plugins: [localAtlas(), notices()],
  // An atlas build writes tens of thousands of files into these; watching them stalls the dev server.
  server: { watch: { ignored: ['**/.cache/**', '**/.atlas/**'] } },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  worker: { format: 'es' },
  test: { include: ['test/**/*.test.ts'] },
}));
