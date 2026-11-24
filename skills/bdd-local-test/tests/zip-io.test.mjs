import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { openZip, writeZip } from '../scripts/lib/zip-io.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdd-zip-io-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return { dir, zip: path.join(dir, 'archive.zip') };
}

test('streams file and memory entries, retaining their names, content and source timestamps', async t => {
  const { dir, zip } = await fixture(t);
  const source = path.join(dir, 'report.md');
  const content = Buffer.from('測試報告\n'.repeat(32000));
  const mtime = new Date('2021-02-03T04:05:06Z');
  await fs.writeFile(source, content);
  await fs.utimes(source, mtime, mtime);
  await writeZip(zip, [
    { name: '主題/report.md', path: source },
    { name: '主題/empty.txt', data: Buffer.alloc(0), mtime },
  ]);
  const reader = await openZip(zip);
  try {
    assert.deepEqual(reader.entries.map(e => e.name), ['主題/report.md', '主題/empty.txt']);
    assert.deepEqual(reader.entries.map(e => e.mtime), [mtime, mtime]);
    assert.deepEqual(await buffer(await reader.entries[0].open()), content);
    assert.equal((await buffer(await reader.entries[1].open())).length, 0);
  } finally { await reader.close(); }
  await assert.rejects(openZip(zip, { maxEntries: 1 }), /上限/);
});

test('detects a corrupted payload even when the ZIP still declares its original size', async t => {
  const { zip } = await fixture(t);
  const content = Buffer.from('fixture CRC payload');
  await writeZip(zip, [{ name: 'report.md', data: content, compress: false }]);
  const bytes = await fs.readFile(zip);
  const offset = bytes.indexOf(content);
  assert.notEqual(offset, -1);
  bytes[offset] ^= 1;
  await fs.writeFile(zip, bytes);
  const reader = await openZip(zip);
  try {
    await assert.rejects(async () => buffer(await reader.entries[0].open()), /CRC32/);
  } finally { await reader.close(); }
});

test('retains an existing target and removes an incomplete new ZIP on input failure', async t => {
  const { dir, zip } = await fixture(t);
  const content = Buffer.from('previous content');
  await fs.writeFile(zip, content);
  await assert.rejects(writeZip(zip, []), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(zip), content);
  const partial = path.join(dir, 'partial.zip');
  await assert.rejects(writeZip(partial, [
    { name: 'ok.txt', data: content },
    { name: 'missing.txt', path: path.join(dir, 'missing.txt') },
  ]), { code: 'ENOENT' });
  await assert.rejects(fs.stat(partial), { code: 'ENOENT' });
});
