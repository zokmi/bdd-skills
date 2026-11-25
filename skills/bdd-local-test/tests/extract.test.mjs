import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { writeZip } from '../scripts/lib/zip-io.mjs';
import { expandArchive } from '../scripts/lib/extract.mjs';

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-extract-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { archive: path.join(dir, 'old.zip'), to: path.join(dir, 'restored') };
}

const data = Buffer.from('原始測試內容');
const hash = createHash('sha256').update(data).digest('hex').toUpperCase();
function archiveEntries() {
  const manifest = { topic: 'legacy-topic', legacy: true, aliases: { 'copy.txt': 'source.txt' },
    files: { 'source.txt': { sha256: hash }, 'copy.txt': { sha256: hash } } };
  return [{ name: 'topic/source.txt', data },
    { name: 'topic/bdd-manifest.json', data: Buffer.from(JSON.stringify(manifest)) }];
}

test('restores historical topic and independent alias files, skipping identical data on retry', async t => {
  const opts = fixture(t);
  await writeZip(opts.archive, archiveEntries());
  const restored = await expandArchive(opts);
  assert.equal(restored.folder, path.join(opts.to, 'topic'));
  assert.equal(restored.verifiedFiles, 2);
  assert.equal(restored.written, 1);
  assert.equal(restored.restoredAliases, 1);
  const source = path.join(restored.folder, 'source.txt');
  const copy = path.join(restored.folder, 'copy.txt');
  assert.equal(restored.hashes[copy], hash);
  assert.equal(fs.existsSync(path.join(restored.folder, 'bdd-manifest.json')), false);
  assert.equal((await expandArchive(opts)).skippedIdentical, 2);
  fs.writeFileSync(copy, 'edited');
  await assert.rejects(expandArchive(opts), /不覆蓋/);
  assert.deepEqual(fs.readFileSync(source), data);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'edited');
});

test('limits count both payloads and aliases before publishing', async t => {
  const opts = fixture(t);
  await writeZip(opts.archive, archiveEntries());
  await assert.rejects(expandArchive({ ...opts, maxOutputBytes: data.length }), /位元組上限/);
  assert.equal(fs.existsSync(opts.to), false);
  await assert.rejects(expandArchive({ ...opts, maxEntries: 1 }), /ZIP 項目數上限/);
  assert.equal(fs.existsSync(opts.to), false);
});

test('rejects unsafe legacy evidence names before publishing earlier files', async t => {
  const opts = fixture(t);
  await writeZip(opts.archive, [{ name: 'valid.png', data }, { name: 'nested/file.png:alternate', data }]);
  await assert.rejects(expandArchive({ ...opts, evidenceZip: true }), /不安全的路徑/);
  assert.equal(fs.existsSync(opts.to), false);
});

test('flattens a historical evidence ZIP into evidence/ and rejects a conflicting destination as one batch', async t => {
  const opts = fixture(t);
  await writeZip(opts.archive, [{ name: 'new.txt', data }, { name: 'EVIDENCE/old.txt', data }]);
  const evidence = path.join(opts.to, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'old.txt'), 'keep');
  await assert.rejects(expandArchive({ ...opts, evidenceZip: true }), /不覆蓋/);
  assert.deepEqual(fs.readdirSync(evidence), ['old.txt']);
  assert.equal(fs.readFileSync(path.join(evidence, 'old.txt'), 'utf8'), 'keep');
  fs.writeFileSync(path.join(evidence, 'old.txt'), data);
  const result = await expandArchive({ ...opts, evidenceZip: true });
  assert.deepEqual(result.writtenPaths, [path.join(evidence, 'new.txt')]);
  assert.equal(result.skippedIdentical, 1);
});

test('rolls back files published earlier when a later publication fails, preserving existing data', async t => {
  const opts = fixture(t);
  fs.mkdirSync(opts.to);
  fs.writeFileSync(path.join(opts.to, 'existing.txt'), data);
  await writeZip(opts.archive, ['new/first.txt', 'existing.txt', 'new/second.txt'].map(name => ({ name, data })));
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (source, dest) => {
    if (dest === path.join(opts.to, 'new/second.txt')) throw new Error('fixture publication interrupted');
    link(source, dest);
  });
  await assert.rejects(expandArchive(opts), /fixture publication interrupted/);
  assert.deepEqual(fs.readdirSync(opts.to), ['existing.txt']);
  assert.deepEqual(fs.readFileSync(path.join(opts.to, 'existing.txt')), data);
});

test('a schema 2 archive cannot publish a payload omitted from its hash manifest', async t => {
  const opts = fixture(t);
  const entries = archiveEntries();
  const manifest = JSON.parse(entries[1].data.toString());
  entries[1].data = Buffer.from(JSON.stringify({ ...manifest, schema: 2 }));
  entries.push({ name: 'topic/extra.txt', data });
  await writeZip(opts.archive, entries);
  await assert.rejects(expandArchive(opts), /SHA-256/);
  assert.equal(fs.existsSync(opts.to), false);
});
