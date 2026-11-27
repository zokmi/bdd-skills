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

test('only an active local archive can be explicitly trusted without upload verification', async t => {
  const f = await fixture(t);
  await f.publish();
  const [created] = fs.readFileSync(f.index, 'utf8').split('\n');
  fs.writeFileSync(f.index, created + '\n');
  assert.equal((await f.command('--apply')).items[0].action, 'keep');
  assert.equal((await f.command('--allow-local-only')).items[0].action, 'prune');
  fs.appendFileSync(f.index, JSON.stringify({ event: 'status', archive: f.zip, status: 'superseded' }) + '\n');
  assert.equal((await f.command('--allow-local-only', '--apply')).items[0].action, 'keep');
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

async function batchFixture(t, count) {
  const f = await fixture(t);
  await f.publish();
  const items = new Map([[topic, { zip: f.zip, evidence: f.evidence }]]);
  for (let i = 1; i < count; i++) {
    const name = 'batch-' + i, file = 'evidence/a.txt';
    const zip = path.join(f.root, name + '.zip'), evidence = path.join(f.repo, '.bdd', name, 'evidence');
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'a.txt'), payload);
    const manifest = { schema: 2, topic: name, files: { [file]: { sha256: sha(payload) } } };
    await writeZip(zip, [{ name: name + '/' + file, data: payload },
      { name: name + '/bdd-manifest.json', data: Buffer.from(JSON.stringify(manifest)) }]);
    const created = { event: 'created', archive: zip, repo: f.repo, topic: name, sha256: sha(fs.readFileSync(zip)) };
    const status = { event: 'status', archive: zip, status: 'uploaded-verified', attachments: ['1'] };
    fs.appendFileSync(f.index, [created, status].map(event => JSON.stringify(event)).join('\n') + '\n');
    items.set(name, { zip, evidence });
  }
  const ordered = fs.readdirSync(path.join(f.repo, '.bdd')).filter(name => items.has(name)).map(name => items.get(name));
  return { ...f, ordered };
}

test('apply replays one authoritative index per small batch', async t => {
  const f = await batchFixture(t, 8);
  const parse = JSON.parse;
  const firstEvent = fs.readFileSync(f.index, 'utf8').split('\n', 1)[0];
  let replays = 0, summary;
  t.mock.method(JSON, 'parse', (text, ...args) => {
    if (text === firstEvent) replays++;
    return parse(text, ...args);
  });
  t.mock.method(performance, 'now', () => 0);
  t.mock.method(console, 'log', value => { summary = parse(value); });
  await pruneCommand([...f.args, '--apply']);
  assert.deepEqual(summary.items.map(i => i.action), Array(8).fill('pruned'));
  assert.equal(replays, 3);
  assert.equal(summary.prunableBytes, payload.length * 8);
});

test('prune batches the literal Git preflight and reports tracked evidence per topic', async t => {
  const f = await batchFixture(t, 5);
  execFileSync('git', ['init', '-q', f.root]);
  const tracked = ['.bdd/' + topic + '/evidence/a.txt', '.bdd/batch-2/evidence.zip'];
  fs.writeFileSync(path.join(f.repo, tracked[1]), 'tracked ZIP');
  execFileSync('git', ['-C', f.repo, '--literal-pathspecs', 'add', '-f', '--', ...tracked]);
  const trace = path.join(f.base, 'trace.jsonl');
  const { stdout } = await run(process.execPath, [cli, 'prune', ...f.args], {
    windowsHide: true, env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  const { items } = JSON.parse(stdout);
  assert.deepEqual(items.map(i => i.path), f.ordered.map(i => path.dirname(i.evidence)));
  for (const file of tracked) {
    const item = items.find(i => i.topic === file.split('/')[1]);
    assert.equal(item.action, 'keep');
    assert.ok(item.reason.endsWith(file));
  }
  assert.equal(items.filter(i => i.action === 'prune').length, 3);
  const starts = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(e => e.event === 'start');
  const preflight = starts.filter(e => e.argv.includes('ls-files'));
  assert.equal(preflight.length, 1);
  assert.ok(preflight[0].argv.includes('--literal-pathspecs'));
  assert.equal(starts.filter(e => e.argv.includes('rev-parse')).length, 1);
  assert.equal(starts.filter(e => e.argv.includes('check-ignore')).length, 0);
});

test('changes during a batch retain revoked, edited or replaced evidence and allow other topics to finish', async t => {
  const f = await batchFixture(t, 5);
  const [first, revoked, edited, replaced, last] = f.ordered;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    rename(source, target);
    if (source !== first.evidence) return;
    fs.appendFileSync(f.index, JSON.stringify({ event: 'status', archive: revoked.zip, status: 'superseded' }) + '\n');
    fs.writeFileSync(path.join(edited.evidence, 'a.txt'), 'new evidence');
    fs.writeFileSync(replaced.zip, 'replacement');
  });
  let summary;
  t.mock.method(console, 'log', value => { summary = JSON.parse(value); });
  await pruneCommand([...f.args, '--apply']);
  assert.deepEqual(summary.items.map(i => i.action), ['pruned', 'keep', 'keep', 'keep', 'pruned']);
  assert.deepEqual(fs.readFileSync(path.join(revoked.evidence, 'a.txt')), payload);
  assert.equal(fs.readFileSync(path.join(edited.evidence, 'a.txt'), 'utf8'), 'new evidence');
  assert.deepEqual(fs.readFileSync(path.join(replaced.evidence, 'a.txt')), payload);
  assert.equal(fs.existsSync(last.evidence), false);
  assert.equal(summary.prunableBytes, payload.length * 2);
});

test('apply retains files added to the Git index after the shared prune preflight', async t => {
  const f = await batchFixture(t, 3);
  const [moving, next, last] = f.ordered;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (source === moving.evidence) {
      const files = [moving, next].map(i => path.relative(f.repo, path.join(i.evidence, 'a.txt')));
      execFileSync('git', ['-C', f.repo, '--literal-pathspecs', 'add', '-f', '--', ...files]);
    }
    rename(source, target);
  });
  let summary;
  t.mock.method(console, 'log', value => { summary = JSON.parse(value); });
  await pruneCommand([...f.args, '--apply']);
  assert.deepEqual(summary.items.map(i => i.action), ['keep', 'keep', 'pruned']);
  for (const [i, entry] of [moving, next].entries()) {
    assert.match(summary.items[i].reason, /git 追蹤/);
    assert.deepEqual(fs.readFileSync(path.join(entry.evidence, 'a.txt')), payload);
  }
  assert.equal(fs.existsSync(last.evidence), false);
});

test('a partially completed deletion stops the batch and leaves later topics untouched', async t => {
  const f = await batchFixture(t, 4);
  const [first, partial, ...later] = f.ordered;
  fs.writeFileSync(path.join(partial.evidence, 'b.txt'), payload);
  let attempted = 0;
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => {
    const relative = path.relative(path.dirname(partial.evidence), file);
    if (relative.startsWith('.bdd-prune-') && ++attempted === 2) throw new Error('fixture deletion interrupted');
    return unlink(file);
  });
  await assert.rejects(pruneCommand([...f.args, '--apply']), /已清理 1 個.*fixture deletion interrupted/);
  assert.equal(fs.existsSync(first.evidence), false);
  assert.equal(fs.readdirSync(partial.evidence).length, 1);
  for (const item of later) assert.deepEqual(fs.readFileSync(path.join(item.evidence, 'a.txt')), payload);
  assert.equal(fs.existsSync(f.index + '.lock'), false);
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

test('apply rejects archive roots that enter or leave the worktree through a directory link', async t => {
  const f = await fixture(t);
  await f.publish();
  const outside = path.join(f.base, 'into-repo'), inside = path.join(f.repo, 'into-archives');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(f.repo, outside, linkType);
  fs.symlinkSync(f.root, inside, linkType);
  for (const root of [path.join(outside, 'missing'), inside]) {
    await assert.rejects(pruneCommand(['--repo', f.repo, '--archive-root', root, '--apply']), /worktree 內/);
  }
  assert.deepEqual(fs.readFileSync(path.join(f.evidence, 'a.txt')), payload);
  assert.equal(fs.existsSync(f.zip), true);
});
