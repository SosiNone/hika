import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';

/** Streams every entry of a zip archive matching `filter` into `outDir`; returns the written paths. */
export async function unzipTo(zipPath: string, outDir: string, filter: (name: string) => boolean = () => true): Promise<string[]> {
  const written: string[] = [];
  const pending: Promise<void>[] = [];
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (file.name.endsWith('/') || !filter(file.name)) return;
    const target = join(outDir, file.name);
    if (existsSync(target)) { written.push(target); return; }
    mkdirSync(dirname(target), { recursive: true });
    const out = createWriteStream(target);
    pending.push(new Promise((resolve, reject) => {
      file.ondata = (err, chunk, final) => {
        if (err) return reject(err);
        out.write(chunk);
        if (final) out.end(resolve);
      };
    }));
    written.push(target);
    file.start();
  };
  await new Promise<void>((resolve, reject) => {
    createReadStream(zipPath)
      .on('data', (chunk) => unzip.push(chunk as Uint8Array))
      .on('end', () => { unzip.push(new Uint8Array(0), true); resolve(); })
      .on('error', reject);
  });
  await Promise.all(pending);
  return written;
}
