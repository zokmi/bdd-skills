import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pruneCommand } from '../scripts/lib/prune.mjs';
import { writeZip } from '../scripts/lib/zip-io.mjs';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const run = promisify(execFile);
const sha = data => createHash('sha256').update(data).digest('hex').toUpperCase();
const payload = Buffer.from('已封存的證據');
const topic = '123-[測試]';

async function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-prune-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const repo = path.join(base, 'repo'), root = path.join(base, 'archives');
  const output = path.join(repo, '.bdd', topic);
  const evidence = path.join(output, 'evidence'), zip = path.join(root, 'copy.zip');
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', repo], { windowsHide: true });
  fs.writeFileSync(path.join(evidence, 'a.txt'), payload);
  fs.writeFileSync(path.join(output, 'REPORT.md'), 'keep');
  const index = path.join(root, 'index.jsonl');
  const manifest = { schema: 2, topic, aliases: { 'evidence/b.txt': 'evidence/a.txt' },
    files: Object.fromEntries(['evidence/a.txt', 'evidence/b.txt'].map(name => [name, { sha256: sha(payload), size: payload.length }])) };
  async function publish({ owner = repo, archiveTopic = topic, omit = false } = {}) {
    const m = { ...manifest, topic: archiveTopic };
    const entries = [{ name: archiveTopic + '/bdd-manifest.json', data: Buffer.from(JSON.stringify(m)) }];
    if (!omit) entries.push({ name: archiveTopic + '/evidence/a.txt', data: payload });
    await writeZip(zip, entries);
    const bytes = fs.readFileSync(zip);
    const created = { event: 'created', archive: zip, repo: owner, topic, sha256: sha(bytes), bytes: bytes.length };
    const status = { event: 'status', archive: zip, status: 'uploaded-verified', attachments: ['1'] };
    fs.writeFileSync(index, JSON.stringify(created) + '\n' + JSON.stringify(status) + '\n');
  }
  const args = ['--repo', repo, '--archive-root', root];
  async function command(...flags) {
    const { stdout } = await run(process.execPath, [cli, 'prune', ...args, ...flags], { windowsHide: true });
    return JSON.parse(stdout);
  }
  return { base, repo, root, output, evidence, zip, index, args, publish, command };
}

test('prune validates the actual archive and repository before removing loose and legacy evidence', async t => {
  const f = await fixture(t);
  await writeZip(path.join(f.output, 'evidence.zip'), [{ name: 'b.txt', data: payload }]);
  await f.publish({ owner: path.join(f.base, 'other-repo') });
  assert.equal((await f.command('--apply')).items[0].action, 'keep');
  fs.unlinkSync(f.zip);
  await f.publish({ omit: true });
  assert.equal((await f.command('--apply')).items[0].action, 'keep');
  fs.unlinkSync(f.zip);
  await f.publish({ archiveTopic: 'different-topic' });
  assert.equal((await f.command('--apply')).items[0].action, 'keep');
  fs.unlinkSync(f.zip);
  await f.publish();
  const indexLines = fs.readFileSync(f.index, 'utf8').trim().split('\n');
  const verified = JSON.parse(indexLines[1]);
  fs.writeFileSync(f.index, indexLines[0] + '\n' + JSON.stringify({ ...verified, attachments: ['   '] }) + '\n');
  assert.equal((await f.command('--apply')).items[0].action, 'keep');
  assert.equal((await f.command('--allow-local-only')).items[0].action, 'prune');
  fs.writeFileSync(f.index, indexLines.join('\n') + '\n');
  const plan = await f.command();
  assert.equal(plan.items[0].action, 'prune');
  assert.deepEqual(plan.items[0].coveredBy, [f.zip]);
  assert.equal(fs.readFileSync(path.join(f.evidence, 'a.txt')).equals(payload), true);
  assert.equal((await f.command('--apply')).items[0].action, 'pruned');
  assert.deepEqual(fs.readdirSync(f.output), ['REPORT.md']);
  assert.equal((await f.command('--apply')).items.length, 0);
});

test('retains a tracked evidence file whose topic contains git pathspec characters', async t => {
  const f = await fixture(t);
  await f.publish();
  execFileSync('git', ['-C', f.repo, '--literal-pathspecs', 'add', '--', path.relative(f.repo, path.join(f.evidence, 'a.txt'))]);
  const item = (await f.command('--apply')).items[0];
  assert.equal(item.action, 'keep');
  assert.match(item.reason, /git 追蹤/);
  assert.deepEqual(fs.readFileSync(path.join(f.evidence, 'a.txt')), payload);
});

test('keeps evidence added while the original directory is being staged', async t => {
  const f = await fixture(t);
  await f.publish();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    rename(source, target);
    if (source === f.evidence) fs.writeFileSync(path.join(target, 'new.txt'), 'new evidence');
  });
  let output;
  t.mock.method(console, 'log', value => { output = JSON.parse(value); });
  assert.equal(await pruneCommand([...f.args, '--apply']), 0);
  assert.equal(output.items[0].action, 'keep');
  assert.deepEqual(fs.readdirSync(f.evidence).sort(), ['a.txt', 'new.txt']);
  assert.deepEqual(fs.readdirSync(f.output).sort(), ['REPORT.md', 'evidence']);
});

test('an imported WebP needs a verified local conversion to cover its original image', async t => {
  const f = await fixture(t);
  // These are matching 16×16 lossless images in their original and converted formats.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGOs1nVmIAUwkaSaYVQDcYCJSHVwMKqBGEByKAEAAk8BC72JhXYAAAAASUVORK5CYII=', 'base64');
  const webp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvD8ADAAfQlu51qP+BiOh/AAA=', 'base64');
  fs.unlinkSync(path.join(f.evidence, 'a.txt'));
  fs.writeFileSync(path.join(f.evidence, 's.png'), png);
  const entry = { size: webp.length, sha256: sha(webp), originalSha256: sha(png), originalName: 'evidence/s.png',
    encoder: 'pillow', lossless: true };
  const manifest = { schema: 2, topic, files: { 'evidence/s.webp': entry } };
  async function zipWithFolder(folder) {
    await writeZip(f.zip, [
      { name: folder + '/evidence/s.webp', data: webp },
      { name: folder + '/bdd-manifest.json', data: Buffer.from(JSON.stringify({ ...manifest, topic: folder, legacy: true })) },
    ]);
    return sha(fs.readFileSync(f.zip));
  }
  const originalArchive = await zipWithFolder(topic);
  const created = { event: 'created', archive: f.zip, legacy: true, repo: f.repo, topic, sha256: originalArchive };
  const status = { event: 'status', status: 'uploaded-verified', attachments: ['1'], archive: f.zip };
  const setIndex = (...events) => fs.writeFileSync(f.index, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  setIndex(created, status);
  assert.equal((await f.command('--apply')).items[0].action, 'keep');
  fs.unlinkSync(f.zip);
  const changed = await zipWithFolder('older-folder');
  const recompressed = { event: 'recompressed', archive: f.zip, previousSha256: originalArchive, sha256: changed };
  setIndex(created, status, recompressed);
  assert.equal((await f.command('--apply')).items[0].action, 'keep');
  setIndex(created, status, { ...recompressed, verifiedOriginalSha256: [sha(png)] });
  assert.equal((await f.command('--apply')).items[0].action, 'pruned');
  assert.deepEqual(fs.readdirSync(f.output), ['REPORT.md']);
});

test('a linked evidence directory preserves the linked target', async t => {
  const f = await fixture(t);
  await f.publish();
  const detached = path.join(f.base, 'detached');
  fs.renameSync(f.evidence, detached);
  fs.symlinkSync(detached, f.evidence, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.command('--apply')).items[0].action, 'keep');
  assert.deepEqual(fs.readFileSync(path.join(detached, 'a.txt')), payload);
});
