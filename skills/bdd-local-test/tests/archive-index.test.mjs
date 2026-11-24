import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readArchiveStates } from '../scripts/lib/archive-index.mjs';
import { archiveIndexCommand } from '../scripts/lib/archive-manager.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdd-index-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'store');
  const source = path.join(dir, '舊證據.zip');
  const index = path.join(root, 'index.jsonl');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, BDD_ARCHIVE_ROOT: '' };
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, 'archive-index', ...args], { cwd: dir, env })).stdout);
  await writeFile(source, 'original');
  const importArgs = ['--import', '--archive-root', 'store', '--issue', '42', '--topic', '42-test', '--archive', source];
  return { dir, root, index, source, importArgs, run };
}

test('replays historical BOM-prefixed events, preserves the first issue hash and retains attachments', async t => {
  const { root, index, run } = await fixture(t);
  const empty = await run('--list', '--archive-root', 'store');
  assert.deepEqual(empty, { archiveRoot: root, count: 0, archives: [] });
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  const archive = path.join(root, '42', 'legacy', 'one.zip');
  await mkdir(path.dirname(archive), { recursive: true });
  await writeFile(archive, 'current');
  const sha256 = createHash('sha256').update('current').digest('hex').toUpperCase();
  const events = [
    { event: 'created', name: 'one.zip', issue: '42', topic: 'Mixed', sha256: 'v1', bytes: 1 },
    { event: 'status', status: 'uploaded-verified', attachments: ['a'] },
    { event: 'recompressed', sha256: 'v2', previousSha256: 'v1', bytes: 2 },
    { event: 'recompressed', sha256, previousSha256: 'v2', bytes: 7 },
  ].map((e, i) => JSON.stringify({ ...e, archive, at: String(i) }));
  await writeFile(index, '\uFEFF' + events.join('\r\n'));
  const listed = await run('--list', '--archive', '~/store/42/legacy/one.zip', '--topic', 'mixed');
  assert.equal(listed.count, 1);
  const [state] = listed.archives;
  assert.equal(state.sha256, sha256);
  assert.equal(state.issueCopySha256, 'v1');
  assert.equal(state.recompressed, true);
  assert.equal(state.status, 'uploaded-verified');
  assert.deepEqual(state.attachments, ['a']);
  assert.equal(state.exists, true);
  const marked = await run('--mark', '--archive', archive, '--status', 'uploaded', '--attachment', ' a, b', '--attachment', 'c');
  assert.deepEqual(marked.attachments, ['a', 'b', 'c']);
  assert.equal(marked.previousStatus, 'uploaded-verified');
  assert.equal((await run('--list', '--archive', archive)).archives[0].status, 'uploaded');
});

test('resolves literal home paths for an archive root and a repository', async t => {
  const { dir, root, run } = await fixture(t);
  const repo = path.join(dir, 'repo');
  await mkdir(path.join(repo, '.bdd'), { recursive: true });
  await exec('git', ['-C', repo, 'init', '-q']);
  await writeFile(path.join(repo, '.bdd', 'config.json'), JSON.stringify({ archiveRoot: '~/store' }));
  assert.equal((await run('--list', '--archive-root', '~/store')).archiveRoot, root);
  assert.equal((await run('--list', '--repo', '~/repo')).archiveRoot, root);
});

test('concurrent imports publish one event and retain the source until a requested move succeeds', async t => {
  const { root, index, source, importArgs, run } = await fixture(t);
  const attempts = await Promise.allSettled([run(...importArgs), run(...importArgs)]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.match(attempts.find(a => a.status === 'rejected').reason.stderr, /已有/);
  assert.equal((await readFile(index, 'utf8')).trim().split('\n').length, 1);
  assert.equal(await readFile(source, 'utf8'), 'original');
  const next = path.join(path.dirname(source), '另一份.zip');
  await writeFile(next, 'another');
  const moved = await run('--import', '--archive-root', root, '--issue', '42', '--topic', '42-test', '--archive', next, '--move');
  assert.equal(moved.movedSource, true);
  assert.equal(await readFile(moved.archive, 'utf8'), 'another');
  await assert.rejects(readFile(next), { code: 'ENOENT' });
});

test('legacy original hashes require a linked recompression event and are excluded from public listings', async t => {
  const { root, index, run } = await fixture(t);
  await mkdir(root);
  const archive = path.join(root, 'legacy.zip');
  const created = 'a'.repeat(64), next = 'b'.repeat(64), last = 'c'.repeat(64);
  const foo = 'd'.repeat(64), bar = 'e'.repeat(64);
  const events = [
    { event: 'created', sha256: created, legacy: true, verifiedOriginalSha256: [created] },
    { event: 'recompressed', previousSha256: created.toUpperCase(), sha256: next, verifiedOriginalSha256: [foo] },
    { event: 'recompressed', previousSha256: next, sha256: last, verifiedOriginalSha256: [bar, foo] },
  ];
  const save = () => writeFile(index, events.map(e => JSON.stringify({ ...e, archive })).join('\n'));
  const originals = async () => (await readArchiveStates(index, { includeVerifiedOriginals: true }))[0].verifiedOriginalSha256;
  await save();
  assert.deepEqual(await originals(), [foo.toUpperCase(), bar.toUpperCase()]);
  assert.equal(Object.hasOwn((await run('--list', '--archive-root', root)).archives[0], 'verifiedOriginalSha256'), false);
  events.push({ event: 'recompressed', previousSha256: created, sha256: next, verifiedOriginalSha256: [bar] });
  await save();
  assert.deepEqual(await originals(), []);
  events.push({ event: 'recompressed', previousSha256: next, sha256: last, verifiedOriginalSha256: [foo, 'malformed'] });
  await save();
  assert.deepEqual(await originals(), []);
  events[0].legacy = false;
  events.splice(3);
  await save();
  assert.deepEqual(await originals(), []);
});

test('a changed destination after the index append prevents deletion of the only verified source', async t => {
  const { root, source } = await fixture(t);
  const target = path.join(root, '42', 'legacy', path.basename(source));
  const rename = fs.promises.rename;
  let altered = false, summary;
  const duringMove = t.mock.method(fs.promises, 'rename', async (from, to) => {
    await rename(from, to);
    if (from === source) {
      await writeFile(target, 'changed after publication');
      altered = true;
    }
  });
  syncBuiltinESMExports();
  const output = t.mock.method(console, 'log', row => { summary = JSON.parse(row); });
  try {
    await archiveIndexCommand(['--import', '--archive-root', root, '--issue', '42', '--topic', '42-test', '--archive', source, '--move']);
  } finally {
    output.mock.restore();
    duringMove.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(altered, true);
  assert.equal(summary.movedSource, false);
  assert.match(summary.warnings.join(' '), /封存副本在匯入期間變動/);
  assert.equal(await readFile(source, 'utf8'), 'original');
  assert.equal(await readFile(target, 'utf8'), 'changed after publication');
});

test('failed imports never move the source, overwrite existing archives, or publish through a linked issue directory', async t => {
  const { dir, root, source, importArgs, run } = await fixture(t);
  await assert.rejects(run('--import', '--archive', source, '--archive-root', root, '--issue', '..', '--topic', 't', '--move'), /不安全/);
  await mkdir(root);
  const outside = path.join(dir, 'separate');
  await mkdir(outside);
  const issue = path.join(root, '42');
  await symlink(outside, issue, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run(...importArgs, '--move'), /獨立目錄/);
  assert.deepEqual(await readdir(outside), []);
  await rm(issue);
  const legacy = path.join(issue, 'legacy');
  await mkdir(legacy, { recursive: true });
  const target = path.join(legacy, path.basename(source));
  await writeFile(target, 'preserve');
  await assert.rejects(run(...importArgs, '--move'), /同名但內容不同/);
  assert.equal(await readFile(target, 'utf8'), 'preserve');
  assert.equal(await readFile(source, 'utf8'), 'original');
  assert.deepEqual(await readdir(legacy), [path.basename(source)]);
  assert.equal((await run('--list', '--archive-root', root)).count, 0);
});
