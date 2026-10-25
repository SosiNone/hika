/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// GitHub Pages serves the site under /<repo>/; override with BASE=/ for a custom domain.
export default defineConfig({
  base: process.env.BASE ?? './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  worker: { format: 'es' },
  test: { include: ['test/**/*.test.ts'] },
});
