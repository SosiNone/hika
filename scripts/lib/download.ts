import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipTo } from './zip';

/** Downloads a (large) zip asset once into .cache/zips and extracts the entries matching `filter`. */
export async function downloadAsset(href: string, name: string, filter: (entry: string) => boolean): Promise<string[]> {
  const zip = await downloadFile(href, 'zips');
  return unzipTo(zip, join('.cache', name), filter);
}

/** Downloads a (large) file once into .cache/<dir>, under its own name; returns its path. */
export async function downloadFile(href: string, dir: string): Promise<string> {
  mkdirSync(join('.cache', dir), { recursive: true });
  const file = join('.cache', dir, basename(new URL(href).pathname));
  if (!existsSync(file)) {
    console.log(`  downloading ${basename(file)} …`);
    const res = await fetch(href);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${href}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${file}.part`));
    renameSync(`${file}.part`, file);
  }
  return file;
}
