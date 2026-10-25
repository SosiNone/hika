import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipTo } from './zip';

/** Downloads a (large) zip asset once into .cache/zips and extracts the entries matching `filter`. */
export async function downloadAsset(href: string, name: string, filter: (entry: string) => boolean): Promise<string[]> {
  mkdirSync('.cache/zips', { recursive: true });
  const zip = join('.cache/zips', basename(new URL(href).pathname));
  if (!existsSync(zip)) {
    console.log(`  downloading ${basename(zip)} …`);
    const res = await fetch(href);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${href}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${zip}.part`));
    renameSync(`${zip}.part`, zip);
  }
  return unzipTo(zip, join('.cache', name), filter);
}
