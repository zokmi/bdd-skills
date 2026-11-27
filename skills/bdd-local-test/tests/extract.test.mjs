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

test('identical restores verify legacy payloads and manifest aliases without writing staged bytes', async t => {
  for (const format of ['legacy', 'schema-2']) {
    await t.test(format, async t => {
      const opts = fixture(t);
      const entries = Array.from({ length: 24 }, (_, i) => ({
        name: 'topic/file-' + i, data: Buffer.alloc(4096, i), compress: false,
      }));
      const files = Object.fromEntries(entries.map(e => [path.posix.basename(e.name),
        { sha256: createHash('sha256').update(e.data).digest('hex') }]));
      let count = entries.length;
      if (format === 'schema-2') {
        files['alias'] = files['file-0'];
        const manifest = { topic: 'topic', schema: 2, files, aliases: { alias: 'file-0' } };
        entries.push({ name: 'topic/bdd-manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
        count++;
      }
      await writeZip(opts.archive, entries);
      const first = await expandArchive(opts);
      assert.equal(first.writtenPaths.length, count);
      const write = fs.createWriteStream;
      let stagedBytes = 0;
      t.mock.method(fs, 'createWriteStream', (...args) => {
        const out = write(...args);
        out.on('close', () => { stagedBytes += out.bytesWritten; });
        return out;
      });
      const copy = t.mock.method(fs, 'copyFileSync');
      const again = await expandArchive(opts);
      assert.equal(again.skippedIdentical, count);
      assert.deepEqual(again.hashes, first.hashes);
      assert.equal(stagedBytes, 0);
      assert.equal(copy.mock.callCount(), 0);
      // A matching destination must never hide a corrupt source payload.
      const bytes = fs.readFileSync(opts.archive);
      const start = bytes.indexOf(entries[5].data);
      assert.notEqual(start, -1);
      bytes[start] ^= 1;
      fs.writeFileSync(opts.archive, bytes);
      await assert.rejects(expandArchive(opts), /CRC32/);
      assert.equal(stagedBytes, 0);
      if (format === 'schema-2') {
        const header = entries.at(-1), manifest = JSON.parse(header.data);
        manifest.files.alias.sha256 = '0'.repeat(64);
        header.data = Buffer.from(JSON.stringify(manifest));
        fs.unlinkSync(opts.archive);
        await writeZip(opts.archive, entries);
        await assert.rejects(expandArchive(opts), /還原後內容不符/);
        assert.equal(stagedBytes, 0);
      }
    });
  }
});

test('an alias that disappears during publication is restored from the verified archive', async t => {
  const opts = fixture(t);
  await writeZip(opts.archive, archiveEntries());
  const folder = path.join(opts.to, 'topic');
  fs.mkdirSync(folder, { recursive: true });
  const source = path.join(folder, 'source.txt'), alias = path.join(folder, 'copy.txt');
  fs.writeFileSync(alias, data);
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    link(from, to);
    if (to === source) {
      fs.writeFileSync(source, 'concurrent edit');
      fs.unlinkSync(alias);
    }
  });
  const result = await expandArchive(opts);
  assert.equal(result.restoredAliases, 1);
  assert.equal(fs.readFileSync(source, 'utf8'), 'concurrent edit');
  assert.deepEqual(fs.readFileSync(alias), data);
});

test('checks the shared parent once between publishing a source and its alias', async t => {
  const opts = fixture(t);
  await writeZip(opts.archive, archiveEntries());
  const folder = path.join(opts.to, 'topic');
  const source = path.join(folder, 'source.txt');
  const alias = path.join(folder, 'copy.txt');
  const lstat = fs.lstatSync, link = fs.linkSync;
  let parentChecks = 0, aliasChecks;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === folder) parentChecks++;
    return lstat(file, ...args);
  });
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (to === source) parentChecks = 0;
    if (to === alias) aliasChecks = parentChecks;
    link(from, to);
  });
  await expandArchive(opts);
  assert.equal(aliasChecks, 1);
});

test('rolls back when a parent is replaced by a directory link during publication', async t => {
  for (const existing of [true, false]) {
    await t.test(existing ? 'existing parent' : 'newly created parent', async t => {
      const opts = fixture(t);
      const first = path.join(opts.to, 'first.txt'), parent = path.join(opts.to, 'group');
      const outside = path.join(path.dirname(opts.to), 'external');
      fs.mkdirSync(opts.to);
      fs.mkdirSync(outside);
      if (existing) fs.mkdirSync(parent);
      await writeZip(opts.archive, [{ name: 'first.txt', data }, { name: 'group/next.txt', data }]);
      function replaceParent() {
        fs.rmdirSync(parent);
        fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
      }
      if (existing) {
        const link = fs.linkSync;
        t.mock.method(fs, 'linkSync', (from, to) => {
          link(from, to);
          if (to === first) replaceParent();
        });
      } else {
        const mkdir = fs.mkdirSync;
        t.mock.method(fs, 'mkdirSync', (dir, ...args) => {
          const result = mkdir(dir, ...args);
          if (dir === parent) replaceParent();
          return result;
        });
      }
      await assert.rejects(expandArchive(opts), /解壓路徑含重新解析點/);
      assert.deepEqual(fs.readdirSync(opts.to), ['group']);
      assert.deepEqual(fs.readdirSync(outside), []);
      fs.unlinkSync(parent);
    });
  }
});

test('a destination edited after verification keeps the edit and rolls back earlier publications', async t => {
  const opts = fixture(t);
  const fresh = path.join(opts.to, 'fresh'), existing = path.join(opts.to, 'existing');
  await writeZip(opts.archive, [{ name: 'fresh', data }, { name: 'existing', data }]);
  fs.mkdirSync(opts.to);
  fs.writeFileSync(existing, data);
  const edit = Buffer.alloc(data.length, 1);
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    link(from, to);
    if (to === fresh) {
      fs.writeFileSync(existing, edit);
      fs.utimesSync(existing, 1, 1);
    }
  });
  await assert.rejects(expandArchive(opts), /不覆蓋/);
  assert.deepEqual(fs.readdirSync(opts.to), ['existing']);
  assert.deepEqual(fs.readFileSync(existing), edit);
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

test('invalid manifest references never publish payloads or read an existing file as an alias', async t => {
  const { archive, to } = fixture(t);
  const existing = path.join(to, 'topic', 'on-disk.txt');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, data);
  for (const change of [
    m => { m.topic = '../outside'; },
    m => { m.aliases = { '../outside.txt': 'source.txt' }; },
    m => { m.aliases['copy.txt'] = '../outside.txt'; },
    m => { m.aliases['copy.txt'] = 'on-disk.txt'; },
    m => { m.files['../outside.txt'] = { sha256: hash }; },
    m => { m.files['source.txt'].sha256 = '0'.repeat(64); },
    m => { m.files['nested/file.txt'] = { sha256: hash }; m.files['nested\\file.txt'] = { sha256: hash }; },
  ]) {
    const entries = archiveEntries();
    const manifest = JSON.parse(entries[1].data);
    delete manifest.legacy;
    manifest.topic = 'topic';
    change(manifest);
    entries[1].data = Buffer.from(JSON.stringify(manifest));
    if (fs.existsSync(archive)) fs.unlinkSync(archive);
    await writeZip(archive, entries);
    await assert.rejects(expandArchive({ archive, to }));
    assert.deepEqual(fs.readdirSync(to), ['topic']);
    assert.deepEqual(fs.readdirSync(path.dirname(existing)), ['on-disk.txt']);
    assert.deepEqual(fs.readFileSync(existing), data);
  }
});

test('restores mixed historical ZIP paths only into regular output directories', async t => {
  const opts = fixture(t);
  const outside = path.join(path.dirname(opts.to), 'external');
  fs.mkdirSync(outside);
  fs.mkdirSync(opts.to);
  const linked = path.join(opts.to, 'old');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await writeZip(opts.archive, [{ name: 'REPORT.md', data }, { name: 'old/nested/file.txt', data }]);
  await assert.rejects(expandArchive(opts));
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(opts.to), ['old']);
  fs.unlinkSync(linked);
  const r = await expandArchive(opts);
  assert.equal(r.hasManifest, false);
  assert.equal(r.written, 2);
  assert.deepEqual(fs.readFileSync(path.join(opts.to, 'old/nested/file.txt')), data);
});
