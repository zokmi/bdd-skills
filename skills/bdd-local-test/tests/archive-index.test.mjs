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
import { appendIndexEvents, archiveIssue, previousArchives, readArchiveStates, withIndexLock } from '../scripts/lib/archive-index.mjs';
import { archiveIndexCommand } from '../scripts/lib/archive-manager.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));

test('group archives infer their issue from both documented dispatch layouts', () => {
  const issueFor = (sourceDir, issue) => archiveIssue({ issue, sourceDir, topic: 'ui' }, { includeBatchDirectory: true });
  assert.equal(issueFor('repo/.bdd/5410-topic/dispatch-R1/groups/ui'), '5410');
  const batch = 'repo\\.bdd\\5410-topic\\release-round\\groups\\ui';
  assert.equal(issueFor(batch), '5410');
  assert.equal(issueFor(batch, 422), '422');
  assert.equal(issueFor('repo/.bdd/5410-topic/groups/ui'), '5410');
  assert.equal(issueFor('repo/.bdd/5410-topic/notes/ui'), '');
  assert.equal(issueFor('repo/.bdd/5410-topic/dispatch-R1/extra/groups/ui'), '');
  assert.equal(archiveIssue({ sourceDir: batch, topic: 'ui' }), '');
});

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

test('brief listings round-trip root-relative and external archive paths to individual full records', async t => {
  const { root, dir, index, run } = await fixture(t);
  const relative = path.join('42', '舊 證據.zip');
  const inside = path.join(root, relative);
  const outside = path.join(dir, 'store-older', path.basename(inside));
  await mkdir(path.dirname(inside), { recursive: true });
  await writeFile(inside, 'current');
  const created = { event: 'created', issue: '42', topic: 'Orders', at: '1', sha256: 'first', bytes: 3 };
  const events = [
    { ...created, archive: inside, legacy: true },
    { ...created, archive: outside },
    { event: 'status', archive: inside, status: 'uploaded-verified', attachments: ['att-1'], at: '2' },
    { event: 'recompressed', archive: inside, previousSha256: 'first', sha256: 'second', bytes: 2 },
  ];
  await writeFile(index, events.map(event => JSON.stringify(event)).join('\n'));
  const list = ['--list', '--archive', inside];
  const full = await run(...list);
  assert.deepEqual(full.archives.map(row => row.archive), [inside, outside]);
  const brief = await run(...list, '--brief', '--issue', '42', '--topic', 'orders');
  assert.deepEqual(brief, { archiveRoot: root, count: 2, archives: [
    { archive: relative, issue: '42', topic: 'Orders', status: 'uploaded-verified', exists: true,
      attachments: ['att-1'], legacy: true, recompressed: true },
    { archive: outside, issue: '42', topic: 'Orders', status: 'local-only', exists: false, attachments: [] },
  ] });
  for (const [i, row] of brief.archives.entries()) {
    assert.deepEqual(await run('--list', '--archive-root', root, '--entry', row.archive),
      { archiveRoot: root, count: 1, archives: [full.archives[i]] });
  }
  const empty = { archiveRoot: root, count: 0, archives: [] };
  assert.deepEqual(await run(...list, '--entry', relative, '--brief', '--issue', '24'), empty);
  assert.deepEqual(await run(...list, '--entry', 'missing.zip'), empty);
});

test('archive list options reject writes and surface index errors without partial output', async t => {
  const { index, root, importArgs, run } = await fixture(t);
  await assert.rejects(run(...importArgs, '--brief'), /--list/);
  await assert.rejects(run(...importArgs, '--entry', 'older.zip'), /--list/);
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  await mkdir(root);
  const row = JSON.stringify({ event: 'created', archive: path.join(root, 'older.zip') });
  await writeFile(index, row + '\n{');
  for (const args of [['--brief'], ['--entry', 'older.zip']]) {
    await assert.rejects(run('--list', '--archive-root', root, ...args), error =>
      error.code === 1 && error.stdout === '' && Boolean(JSON.parse(error.stderr).error));
  }
});

test('the shared writer lock protects existing JSONL including an unterminated last line', async t => {
  const { root, index } = await fixture(t);
  await mkdir(root);
  const a = { event: 'created', archive: path.join(root, 'one.zip'), topic: '第一' };
  const b = { event: 'created', archive: path.join(root, 'two.zip'), topic: '第二' };
  await writeFile(index, JSON.stringify(a));
  await writeFile(index + '.lock', 'other writer');
  const add = () => withIndexLock(index, stat => appendIndexEvents(index, stat, [b]));
  await assert.rejects(add(), /其他程序/);
  assert.equal(await readFile(index, 'utf8'), JSON.stringify(a));
  await rm(index + '.lock');
  await add();
  assert.deepEqual((await readFile(index, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)), [a, b]);
});

test('an upload needs an attachment identifier and marking never certifies a changed ZIP', async t => {
  const { importArgs, run, index } = await fixture(t);
  const { archive } = await run(...importArgs);
  const mark = ['--mark', '--archive', archive, '--status', 'uploaded-verified'];
  const before = await readFile(index);
  await assert.rejects(run(...mark), /附件/);
  await writeFile(archive, 'modified');
  await assert.rejects(run(...mark, '--attachment', '42'), /SHA-256/);
  assert.deepEqual(await readFile(index), before);
});

test('a second archive can be marked while the first archive is being hashed', async t => {
  const { dir, root, index, importArgs, run } = await fixture(t);
  const first = (await run(...importArgs)).archive;
  const source = path.join(dir, 'second.zip');
  await writeFile(source, 'second');
  const second = (await run('--import', '--archive-root', root, '--issue', '42', '--topic', '42-other', '--archive', source)).archive;
  const mark = archive => ['--mark', '--archive-root', root, '--archive', archive, '--status', 'uploaded', '--attachment', '42'];
  const original = fs.createReadStream;
  let markingSecond, summary;
  const output = t.mock.method(console, 'log', row => { summary = JSON.parse(row); });
  const stream = t.mock.method(fs, 'createReadStream', (...args) => {
    if (args[0] !== first) return original(...args);
    assert.equal(fs.existsSync(index + '.lock'), false, 'another mark must be able to acquire the index lock');
    const input = original(...args);
    const iterator = input[Symbol.asyncIterator].bind(input);
    markingSecond = run(...mark(second));
    // The first mark must also see a new status recorded against its own archive during the hash.
    input[Symbol.asyncIterator] = async function* () {
      await markingSecond;
      await run('--mark', '--archive-root', root, '--archive', first, '--status', 'superseded');
      yield* iterator();
    };
    return input;
  });
  syncBuiltinESMExports();
  try {
    await archiveIndexCommand(mark(first));
    assert.equal((await markingSecond).status, 'uploaded');
    assert.equal(summary.previousStatus, 'superseded');
  } finally {
    output.mock.restore();
    stream.mock.restore();
    syncBuiltinESMExports();
  }
  const states = await readArchiveStates(index);
  assert.deepEqual(states.map(s => s.status), ['uploaded', 'uploaded']);
});

test('mark reads only registered files and replays an unchanged index once', async t => {
  const { root, source, index, importArgs, run } = await fixture(t);
  const { archive } = await run(...importArgs);
  const mark = file => archiveIndexCommand(['--mark', '--archive-root', root, '--archive', file, '--status', 'local-only']);
  const original = fs.createReadStream;
  const reads = [];
  const hook = t.mock.method(fs, 'createReadStream', (file, options) => {
    reads.push(file);
    return original(file, options);
  });
  const output = t.mock.method(console, 'log', () => {});
  syncBuiltinESMExports();
  try {
    await assert.rejects(mark(source), /索引裡沒有/);
    assert.deepEqual(reads, [index]);
    reads.length = 0;
    await mark(archive);
    assert.deepEqual(reads, [index, archive]);
  } finally {
    output.mock.restore();
    hook.mock.restore();
    syncBuiltinESMExports();
  }
});

test('mark rejects a file replaced with equal bytes after hashing and before appending', async t => {
  const { root, index, importArgs, run } = await fixture(t);
  const { archive } = await run(...importArgs);
  const before = await readFile(index);
  const open = fs.promises.open;
  let lockAttempts = 0;
  const hook = t.mock.method(fs.promises, 'open', async (file, ...args) => {
    if (file === index + '.lock' && ++lockAttempts === 2) {
      await fs.promises.rename(archive, archive + '.original');
      await fs.promises.copyFile(archive + '.original', archive);
    }
    return open(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(archiveIndexCommand(['--mark', '--archive-root', root, '--archive', archive,
      '--status', 'uploaded-verified', '--attachment', '42']), /核對期間變動/);
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(index), before);
});

test('replays only proven cross-issue automatic replacements without changing the index', async t => {
  const { dir, root, index } = await fixture(t);
  await mkdir(root);
  const repo = path.join(dir, 'repo');
  const source = name => path.join(root, name + '.zip');
  const created = (name, issue, at, extra = {}) => ({
    event: 'created', archive: source(name), issue, topic: 'api', repo, at, ...extra,
  });
  const status = (name, value, at, extra = {}) => ({ event: 'status', archive: source(name), status: value, at, ...extra });
  const events = [
    created('first', '', '1', { sourceDir: path.join(repo, '.bdd', '101-a', 'groups', 'api') }),
    status('first', 'uploaded-verified', '2', { attachments: ['att-1'] }),
    created('same', '202', '3'), created('unknown', '', '4'), created('manual', '101', '5'),
    created('later', '101', '6'), created('unlinked', '101', '6a'),
    created('replacement', '202', '7'),
    ...['first', 'same', 'unknown', 'later'].map(name => status(name, 'superseded', '7', { by: source('replacement') })),
    status('manual', 'superseded', '8'),
    status('unlinked', 'superseded', '8a', { by: source('replacement') }),
    status('later', 'uploaded', '9', { attachments: ['late'] }),
  ];
  const original = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(index, original);
  const expected = { first: 'uploaded-verified', same: 'superseded', unknown: 'superseded', manual: 'superseded', unlinked: 'superseded',
    later: 'uploaded', replacement: 'local-only' };
  const all = await readArchiveStates(index);
  for (const [name, value] of Object.entries(expected)) {
    const state = all.find(s => s.archive === source(name));
    assert.equal(state.status, value, name);
    assert.deepEqual(await readArchiveStates(index, { archive: source(name) }), [state]);
  }
  assert.equal(all[0].statusAt, '2');
  assert.deepEqual(all[0].attachments, ['att-1']);
  assert.deepEqual(await previousArchives(index, await fs.promises.stat(index), created('next', '101', '10')),
    [source('first'), source('later')]);
  assert.equal(await readFile(index, 'utf8'), original);
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
