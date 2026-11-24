import fs from 'node:fs';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openReader, ZipWriter, fallbackCrc32 } from './zip-runtime.mjs';
import { entryLimit } from './archive-limits.mjs';

const crc32 = zlib.crc32 ?? fallbackCrc32;

export async function openZip(file, { maxEntries = entryLimit } = {}) {
  const zip = await openReader(file, { autoClose: false, validateEntrySizes: true });
  const entries = [];
  let closed;
  function close() {
    if (!closed) {
      closed = once(zip, 'close');
      zip.close();
    }
    return closed;
  }
  try {
    if (zip.entryCount > maxEntries) throw new Error('封存超出 ZIP 項目數上限：' + maxEntries);
    for await (const entry of zip.eachEntry()) {
      const size = entry.uncompressedSize;
      const name = entry.fileName;
      const mode = entry.externalFileAttributes >>> 16;
      entries.push({
        name, size, crc32: entry.crc32, mtime: entry.getLastModDate(),
        isDirectory: name.endsWith('/') || (mode & 0xf000) === 0x4000 || Boolean(entry.externalFileAttributes & 0x10),
        isSymlink: (mode & 0xf000) === 0xa000 || Boolean(entry.externalFileAttributes & 0x400),
        async open() {
          const input = await zip.openReadStreamPromise(entry);
          async function* checked() {
            let crc = 0, bytes = 0;
            for await (const chunk of input) {
              bytes += chunk.length;
              if (bytes > size) throw new Error('ZIP entry exceeds its declared size: ' + name);
              crc = crc32(chunk, crc);
              yield chunk;
            }
            if (bytes !== size || crc !== entry.crc32) throw new Error('ZIP CRC32 or size mismatch: ' + name);
          }
          return Readable.from(checked(), { objectMode: false });
        },
      });
    }
    return { entries, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function writeZip(target, entries) {
  const writer = new ZipWriter();
  const file = await fs.promises.open(target, 'wx', 0o600);
  const out = file.createWriteStream();
  let input;
  writer.on('error', error => writer.outputStream.destroy(error));
  const finished = pipeline(writer.outputStream, out);
  try {
    for (const entry of entries) {
      const stat = entry.data === undefined ? fs.statSync(entry.path) : undefined;
      if (stat && !stat.isFile()) throw new Error('Expected a regular file: ' + entry.path);
      const options = {
        compress: entry.compress ?? true,
        mtime: entry.mtime ?? stat?.mtime,
        size: stat?.size ?? entry.data.length,
      };
      writer.addReadStreamLazy(entry.name, options, cb => {
        input = stat ? fs.createReadStream(entry.path) : Readable.from([entry.data]);
        input.on('error', error => writer.emit('error', error));
        cb(null, input);
      });
    }
    writer.end();
    await finished;
  } catch (error) {
    input?.destroy();
    writer.emit('error', error);
    await finished.catch(() => {});
    await file.close();
    await fs.promises.unlink(target);
    throw error;
  }
}
