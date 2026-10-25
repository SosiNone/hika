import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_DIR = '.cache/http';
const MAX_ACTIVE = 6;
let active = 0;
const waiting: (() => void)[] = [];

/** Runs `fn` once one of MAX_ACTIVE request slots is free, so swisstopo's servers are not hammered. */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export interface RequestInit2 { method?: string; body?: string; headers?: Record<string, string> }

/** Fetches `url` through an on-disk cache keyed by URL and body, retrying transient failures. */
export async function fetchCached(url: string, init: RequestInit2 = {}): Promise<Buffer> {
  const key = createHash('sha1').update(url).update(init.body ?? '').digest('hex');
  const file = join(CACHE_DIR, key.slice(0, 2), key);
  if (existsSync(file)) return readFileSync(file);
  const buf = await withSlot(() => fetchRetry(url, init));
  mkdirSync(join(CACHE_DIR, key.slice(0, 2)), { recursive: true });
  writeFileSync(file, buf);
  return buf;
}

export async function fetchJson<T>(url: string, init?: RequestInit2): Promise<T> {
  return JSON.parse((await fetchCached(url, init)).toString('utf8')) as T;
}

async function fetchRetry(url: string, init: RequestInit2, attempt = 0): Promise<Buffer> {
  try {
    const res = await fetch(url, init);
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`), { fatal: true });
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if ((err as { fatal?: boolean }).fatal || attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return fetchRetry(url, init, attempt + 1);
  }
}

/** Runs `fn` over `items` with bounded parallelism, logging progress every `every` items. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>, label?: string, every = 50): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      if (label && ++done % every === 0) console.log(`  ${label}: ${done}/${items.length}`);
    }
  }));
  return out;
}
