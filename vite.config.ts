/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// GitHub Pages serves the site under /<repo>/; override with BASE=/ for a custom domain.
export default defineConfig({
  base: process.env.BASE ?? './',
  build: { target: 'es2022', assetsInlineLimit: 0 },
  worker: { format: 'es' },
  test: { include: ['test/**/*.test.ts'] },
});
