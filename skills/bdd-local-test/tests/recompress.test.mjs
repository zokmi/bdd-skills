import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readArchiveStates } from '../scripts/lib/archive-index.mjs';
import { expandArchive } from '../scripts/lib/extract.mjs';
import { stageArchiveEntries } from '../scripts/lib/recompress.mjs';
import { writeZip } from '../scripts/lib/zip-io.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const helper = fileURLToPath(new URL('../scripts/lib/bdd_webp.py', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex').toUpperCase();

async function fixture(t, entries) {
  const tmp = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tmp, 'bdd-test-recompress-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const archive = path.join(root, '歷史.zip');
  const index = path.join(root, 'index.jsonl');
  await writeZip(archive, entries);
  const original = await readFile(archive);
  const created = { event: 'created', archive, topic: '歷史', issue: '123', legacy: true, sha256: sha(original), bytes: original.length };
  const status = { event: 'status', archive, status: 'uploaded-verified', attachments: ['42'] };
  await writeFile(index, [created, status].map(x => JSON.stringify(x)).join('\n') + '\n');
  const run = (env = {}) => execute(process.execPath, [cli, 'recompress', '--archive', archive], {
    windowsHide: true, env: { ...process.env, BDD_WEBP_ENCODER: 'pillow', ...env },
  }).then(r => JSON.parse(r.stdout));
  return { root, archive, index, original, run };
}

test('an archive modified since indexing is preserved together with the existing index', async t => {
  const f = await fixture(t, [{ name: 'evidence/data.txt', data: Buffer.from('evidence') }]);
  const index = await readFile(f.index);
  const edited = Buffer.concat([f.original, Buffer.from('user edit')]);
  await writeFile(f.archive, edited);
  await assert.rejects(f.run(), /SHA-256/);
  assert.deepEqual(await readFile(f.archive), edited);
  assert.deepEqual(await readFile(f.index), index);
  assert.deepEqual((await readdir(f.root)).sort(), ['index.jsonl', '歷史.zip']);
});

test('stages one physical payload for 64 logical files and checks the hash of each alias', async t => {
  const data = Buffer.alloc(1024 * 1024, 42);
  const digest = sha(data);
  const mtime = new Date('2024-05-06T07:08:10Z');
  const names = Array.from({ length: 64 }, (_, i) => 'evidence/' + i + '.png');
  const aliases = Object.fromEntries(names.slice(1).map(name => [name, names[0]]));
  const files = Object.fromEntries(names.map(name => [name, { sha256: digest, size: data.length, note: name }]));
  const manifest = { schema: 2, topic: '歷史', files, aliases };
  const archiveEntries = () => [{ name: '歷史/' + names[0], data, mtime },
    { name: '歷史/bdd-manifest.json', data: Buffer.from(JSON.stringify(manifest)) }];
  const f = await fixture(t, archiveEntries());
  const staging = path.join(f.root, 'stage');
  await mkdir(staging);
  const { entries } = await stageArchiveEntries(f.archive, staging, 'indexed topic');
  assert.deepEqual(entries.map(e => e.name).sort(), [...names].sort());
  assert.equal((await readdir(staging)).length, 1);
  assert.equal(new Set(entries.map(e => e.path)).size, 1);
  assert.equal((await stat(entries[0].path)).size, data.length);
  for (const e of entries) {
    assert.equal(e.sha256, digest);
    assert.equal(e.size, data.length);
    assert.equal(e.extra.note, e.name);
    assert.equal(e.mtime.getTime(), mtime.getTime());
  }
  files[names.at(-1)].sha256 = sha('different bytes');
  const bad = path.join(f.root, 'invalid.zip'), next = path.join(f.root, 'next-stage');
  await writeZip(bad, archiveEntries());
  await mkdir(next);
  await assert.rejects(stageArchiveEntries(bad, next, 'indexed topic'), /內容不符.*63\.png/);
});

function solidBmp() {
  const side = 64;
  const data = Buffer.alloc(54 + side * side * 3);
  data.write('BM');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(side, 18);
  data.writeInt32LE(side, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  return data;
}

test('concurrent recompression keeps one index transition, historical references and the attachment hash', async t => {
  const available = [['python'], ['python3'], ['py', '-3']].some(([command, ...args]) => {
    const probe = spawnSync(command, [...args, helper, 'check'], { encoding: 'utf8', windowsHide: true });
    return probe.status === 0 && JSON.parse(probe.stdout).ok;
  });
  if (!available) return t.skip('Requires Python with Pillow WebP support');
  const bmp = solidBmp();
  const source = 'evidence/測試.bmp';
  const ledger = { files: { [source]: { method: 'css', sha256: sha(bmp) } } };
  const utf16 = text => Buffer.from('\uFEFF' + text, 'utf16le');
  const resultFile = 'coordination/attempt-2/result.json';
  const otherResult = 'misc/result.json';
  const result = { contractVersion: 1, scenarios: [{ actual: source, evidence: [
    './evidence\\測試.bmp#detail', source + '.txt', 'REPORT.md#test',
  ] }] };
  const originals = [
    { name: source, data: bmp }, { name: 'REPORT.md', data: utf16('![](' + source + ')') },
    { name: 'masking.json', data: utf16(JSON.stringify(ledger)) },
    { name: resultFile, data: utf16(JSON.stringify(result)) }, { name: otherResult, data: utf16(JSON.stringify(result)) },
    { name: 'evidence/second.bmp', data: bmp },
    { name: 'evidence/old.webp', data: Buffer.from('previously imported image') },
  ];
  const files = Object.fromEntries(originals.map(({ name, data }) => [name, { sha256: sha(data), size: data.length }]));
  Object.assign(files['evidence/old.webp'], {
    originalName: 'evidence/old.bmp', originalSha256: sha('unverified legacy claim'), encoder: 'pillow', lossless: true,
  });
  files['evidence\\old.webp'] = files['evidence/old.webp'];
  delete files['evidence/old.webp'];
  originals.push({ name: 'bdd-manifest.json', data: Buffer.from(JSON.stringify({ schema: 2, topic: '歷史', legacy: true, files })) });
  const f = await fixture(t, originals.map(entry => ({ ...entry, name: '歷史/' + entry.name })));
  const [a, b] = await Promise.allSettled([f.run(), f.run()]);
  const changed = [a, b].filter(result => result.status === 'fulfilled' && result.value.changed);
  assert.equal(changed.length, 1, String(a.reason ?? '') + String(b.reason ?? ''));
  for (const result of [a, b]) {
    if (result.status === 'rejected') assert.match(result.reason.message, /SHA-256|已變更|備份/);
  }
  const [state] = await readArchiveStates(f.index);
  const bytes = await readFile(f.archive);
  assert.equal(state.sha256, sha(bytes));
  assert.equal(state.issueCopySha256, sha(f.original));
  assert.equal(state.status, 'uploaded-verified');
  assert.deepEqual(state.attachments, ['42']);
  const beforeRetry = await readFile(f.index);
  const events = beforeRetry.toString().trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 3);
  assert.deepEqual(events[2].verifiedOriginalSha256, [sha(bmp)]);
  assert.equal((await f.run()).changed, false);
  assert.deepEqual(await readFile(f.archive), bytes);
  assert.deepEqual(await readFile(f.index), beforeRetry);
  assert.deepEqual((await readdir(f.root)).sort(), ['index.jsonl', '歷史.zip']);
  const restored = await expandArchive({ archive: f.archive, to: path.join(f.root, 'restore') });
  assert.equal(restored.manifest.legacy, true);
  assert.equal(restored.manifest.files['evidence/old.webp'].originalSha256, sha('unverified legacy claim'));
  const webp = 'evidence/測試.webp';
  assert.equal(restored.manifest.files[webp].originalSha256, sha(bmp));
  const report = await readFile(path.join(restored.folder, 'REPORT.md'), 'utf8');
  assert.equal(report, '![](' + webp + ')');
  const savedLedger = JSON.parse(await readFile(path.join(restored.folder, 'masking.json'), 'utf8'));
  assert.equal(savedLedger.files[webp].derivedFrom.sha256, sha(bmp));
  const rewritten = JSON.parse(await readFile(path.join(restored.folder, resultFile), 'utf8'));
  assert.deepEqual(rewritten.scenarios[0], { actual: source, evidence: [webp + '#detail', source + '.txt', 'REPORT.md#test'] });
  assert.equal(restored.manifest.rewrittenLinks[resultFile], 1);
  assert.deepEqual(await readFile(path.join(restored.folder, otherResult)), utf16(JSON.stringify(result)));
});
