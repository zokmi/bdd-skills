import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const runAsync = promisify(execFile);
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-verify-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  const output = path.join(temp, 'output');
  fs.mkdirSync(repo);
  fs.mkdirSync(output);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'readme'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const args = (...extra) => [cli, 'verification', '--dir', output, ...extra];
  function run(code, ...extra) {
    const res = spawnSync(process.execPath, args(...extra), { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, code, res.stderr + res.stdout);
    return res.stdout && JSON.parse(res.stdout);
  }
  return { repo, output, git, base, run, args };
}

test('records concurrent rounds without losing BOM-prefixed legacy data or top-level fields', async t => {
  const { repo, output, run, base, args } = fixture(t);
  const file = path.join(output, 'verification.json');
  assert.equal(run(2, '--check').verdict, 'no-record');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ source: 'legacy', rounds: [{ note: 'preserve' }] }));
  await Promise.all(['one', 'two', 'three'].map(note =>
    runAsync(process.execPath, args('--record', '--base', base, '--note', note), { cwd: repo })));
  const doc = JSON.parse(fs.readFileSync(file));
  assert.equal(doc.source, 'legacy');
  assert.equal(doc.rounds[0].note, 'preserve');
  assert.deepEqual(doc.rounds.slice(1).map(r => r.note).sort(), ['one', 'three', 'two']);
  delete doc.rounds.at(-1).scenarios;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.equal(run(0, '--check').verdict, 'current');
  const malformed = '{"rounds":{}}';
  fs.writeFileSync(file, malformed);
  run(2, '--record', '--base', base);
  assert.equal(fs.readFileSync(file, 'utf8'), malformed);
  assert.deepEqual(fs.readdirSync(output), ['verification.json']);
});

test('records stable Git patch IDs, detects cherry-picks, rewrites, missing commits and dirty original tests', t => {
  const { git, repo, base, output, run } = fixture(t);
  const file = path.join(repo, '資料.txt');
  fs.writeFileSync(file, 'tested\n');
  git('add', '.');
  git('commit', '-qm', '受測變更');
  const source = git('rev-parse', 'HEAD');
  const rec = () => run(0, '--record', '--commits', source, '--passed', '1');
  const round = rec();
  const diff = execFileSync('git', ['-c', 'core.quotepath=false', 'show', '--format=', source], { cwd: repo });
  const id = execFileSync('git', ['patch-id', '--stable'], { cwd: repo, input: diff, encoding: 'utf8' }).split(' ')[0];
  assert.equal(round.commits[0].patchId, id);
  assert.equal(round.files['資料.txt'], git('rev-parse', 'HEAD:資料.txt'));
  fs.appendFileSync(file, 'dirty');
  assert.deepEqual(rec().dirtyPaths, ['資料.txt']);
  git('restore', '--', '資料.txt');
  assert.equal(run(1, '--check').verdict, 'rerun');
  rec();
  // Historical snapshots can contain enough deleted paths to exceed Win32 argv limits.
  const recordFile = path.join(output, 'verification.json');
  const doc = JSON.parse(fs.readFileSync(recordFile));
  for (let i = 0; i < 520; i++) doc.rounds.at(-1).files['removed/' + 'x'.repeat(64) + i] = null;
  fs.writeFileSync(recordFile, JSON.stringify(doc));
  git('switch', '-qc', 'target', base);
  fs.writeFileSync(path.join(repo, 'other'), 'unrelated\n');
  git('add', '.');
  git('commit', '-qm', 'another');
  assert.equal(run(1, '--check').commits[0].status, 'missing');
  git('cherry-pick', source);
  assert.equal(run(1, '--check').commits[0].status, 'patch');
  fs.writeFileSync(file, 'rewritten\n');
  git('add', '.');
  git('commit', '--amend', '--no-edit', '-q');
  assert.equal(run(1, '--check').commits[0].status, 'subject');
});

test('empty-range records do not validate diverged histories, including repositories with the same remote', t => {
  const { run, git, base, repo } = fixture(t);
  run(0, '--record', '--base', base);
  git('switch', '--orphan', 'unrelated');
  fs.writeFileSync(path.join(repo, 'new'), 'new');
  git('add', '.');
  git('commit', '-qm', 'unrelated');
  assert.equal(run(1, '--check').verdict, 'rerun');
  git('remote', 'add', 'origin', 'https://example.invalid/fixture');
  git('switch', 'main');
  fs.writeFileSync(path.join(repo, 'change'), 'main');
  git('add', '.');
  git('commit', '-qm', 'main change');
  run(0, '--record', '--base', 'HEAD');
  git('switch', '-qc', 'diverged', base);
  fs.writeFileSync(path.join(repo, 'change'), 'other');
  git('add', '.');
  git('commit', '-qm', 'diverged change');
  assert.equal(run(1, '--check').verdict, 'rerun');
});

test('records touched paths and ordered subjects with one Git query each across explicit commits', t => {
  const { repo, output, git, args } = fixture(t);
  git('switch', '-qc', 'side');
  fs.writeFileSync(path.join(repo, 'only-on-side'), 'side');
  git('add', '.');
  git('commit', '-qm', 'side');
  git('switch', 'main');

  const name = process.platform === 'win32' ? '[暫存] file' : '[暫存]\nfile';
  fs.writeFileSync(path.join(repo, name), 'temporary');
  fs.mkdirSync(path.join(repo, '.bdd'));
  fs.writeFileSync(path.join(repo, '.bdd', 'note'), 'internal');
  git('add', '-f', '.');
  git('commit', '-qm', '加入暫存檔');
  const add = git('rev-parse', 'HEAD');
  fs.unlinkSync(path.join(repo, name));
  git('add', '-u');
  git('commit', '-qm', 'remove');
  const remove = git('rev-parse', 'HEAD');
  git('merge', '--no-ff', '-qm', 'merge side', 'side');
  const merge = git('rev-parse', 'HEAD');

  const selected = [remove, merge, add, remove];
  const trace = path.join(output, 'git-trace.ndjson');
  const res = spawnSync(process.execPath, args('--record', '--commits', selected.join(',')), {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const round = JSON.parse(res.stdout);
  assert.deepEqual(round.commits.map(c => c.sha), selected);
  assert.deepEqual(round.commits.map(c => c.subject), ['remove', 'merge side', '加入暫存檔', 'remove']);
  assert.deepEqual(round.files, { [name]: null });

  const queries = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.event === 'start').map(event => event.argv);
  assert.equal(queries.filter(argv => argv.includes('show') && argv.includes('--name-only')).length, 1);
  assert.equal(queries.filter(argv => argv.includes('log')).length, 1);
});
