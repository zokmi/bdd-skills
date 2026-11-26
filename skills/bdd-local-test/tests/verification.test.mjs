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

test('recorded worktrees retain rollback, untracked and scenario deltas across same-HEAD feedback', t => {
  const { repo, git, base } = fixture(t);
  git('config', 'core.autocrlf', 'false');
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), value);
  };
  const feature = '.bdd/modules/shop/price.FEATURE';
  const original = 'Feature: Shop\n@OR-01 @#42 @API\nScenario: Refund\nThen refund is pending\n' +
    '@OR-02 @#42 @API\nScenario: Invoice\nThen invoice is open\n';
  write(feature, original);
  write('.bdd/modules/shop/MODULE.md', '---\nprefix: OR\npaths:\n  - src/**\n---\n');
  write('src/prior.js', 'at HEAD\n');
  write('src/current.js', 'at HEAD\n');
  write('src/obsolete.js', 'removed before testing\n');
  write('.bdd/old-result/REPORT.md', 'old output accidentally tracked\n');
  write('.bdd/old-result/notes.txt', 'staged deletion of old output\n');
  write('.gitignore', 'private.env\ntracked-fixture.tmp\n');
  git('add', '.');
  git('commit', '-qm', 'issue baseline');
  const branchHead = git('rev-parse', 'HEAD');
  git('switch', '--detach', '-q', branchHead);
  git('commit', '--allow-empty', '-qm', 'tested detached checkout');
  const head = git('rev-parse', 'HEAD');

  write('src/prior.js', 'staged only\n');
  git('add', 'src/prior.js');
  write('src/prior.js', 'actually tested\n');
  write('src/retained.bin', Buffer.from([0, 1, 9, 255]));
  write('src/removed.js', 'exists only in first feedback\n');
  git('rm', '-q', '.bdd/old-result/notes.txt');
  fs.unlinkSync(path.join(repo, 'src/obsolete.js'));
  write('tracked-fixture.tmp', 'staged fixture\n');
  git('add', '-f', 'tracked-fixture.tmp');
  write('tracked-fixture.tmp', 'working fixture\n');
  write('private.env', 'ignored fixture\n');
  write('.bdd/42-topic/evidence/private.txt', 'test evidence\n');
  write(feature, original.replace('pending', 'sent'));
  const command = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8' });
  const ok = (...args) => {
    const result = command(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const record = 'src/verification.json'; // Output may share a directory with application files.
  const stat = () => git('rev-parse', ':src/prior.js');
  const staged = stat();
  const round = ok('verification', '--record', '--dir', 'src', '--issue', '42', '--base', base);
  const snapshot = round.worktreeSnapshot;
  assert.equal(snapshot.head, head);
  assert.equal(git('rev-parse', snapshot.ref), snapshot.tree);
  assert.equal(git('show', snapshot.tree + ':src/prior.js'), 'actually tested');
  assert.equal(git('show', snapshot.tree + ':tracked-fixture.tmp'), 'working fixture');
  assert.deepEqual(execFileSync('git', ['cat-file', 'blob', snapshot.tree + ':src/retained.bin'], { cwd: repo }),
    Buffer.from([0, 1, 9, 255]));
  for (const name of ['private.env', '.bdd/42-topic/evidence/private.txt', '.bdd/old-result', record, 'src/obsolete.js']) {
    assert.equal(git('ls-tree', '-r', '--name-only', snapshot.tree, '--', name), '');
  }
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(stat(), staged);
  git('update-index', '--assume-unchanged', 'src/current.js');
  assert.match(command('verification', '--record', '--dir', 'src', '--base', head).stderr, /assume-unchanged/);
  git('update-index', '--no-assume-unchanged', 'src/current.js');
  const args = ['quality-plan', '--issue', '42', '--previous-verification', record,
    '--review-reason', 'batch change', '--impact-complete', '--static-passed'];
  assert.deepEqual(ok(...args).paths, []); // Unchanged untracked and staged-only versions are excluded.

  write('src/prior.js', 'at HEAD\n');
  write('src/current.js', 'second batch\n');
  fs.unlinkSync(path.join(repo, 'src/removed.js'));
  write(feature, original.replace('open', 'paid')); // restore OR-01, update OR-02
  git('gc', '--prune=now', '--quiet');
  const noMappings = ok(...args);
  assert.deepEqual(noMappings.paths, [feature, 'src/current.js', 'src/prior.js', 'src/removed.js']);
  assert.deepEqual([noMappings.base, noMappings.baseHead, noMappings.head], [snapshot.tree, head, head]);
  assert.equal(noMappings.bddStatus, 'BLOCKED');
  assert.deepEqual(noMappings.selected.flatMap(f => f.scenarios.flatMap(s => s.ids)).sort(), ['OR-01', 'OR-02']);
  const selected = ok(...args, '--impact-scenario', 'src/prior.js=OR-01',
    '--impact-scenario', 'src/removed.js=OR-01', '--impact-scenario', 'src/current.js=OR-02');
  assert.equal(selected.bddStatus, 'PENDING');
  assert.equal(stat(), staged);
  assert.equal(git('rev-parse', 'HEAD'), head);

  assert.match(command(...args, '--base', head).stderr, /--base/);
  const wrongIssue = args.map(v => v === '42' ? '41' : v);
  assert.match(command(...wrongIssue).stderr, /單號/);
  const other = path.join(path.dirname(repo), 'other');
  git('clone', '-q', repo, other);
  assert.notEqual(command(...args, '--repo', other).status, 0);
  const rounds = fs.readFileSync(path.join(repo, record), 'utf8');
  fs.writeFileSync(path.join(repo, record), JSON.stringify({ rounds: [round, { head }] }));
  assert.match(command(...args).stderr, /快照/);
  fs.writeFileSync(path.join(repo, record), rounds);
  git('switch', '--detach', '-q', branchHead);
  git('reflog', 'expire', '--expire=now', '--all');
  git('gc', '--prune=now', '--quiet');
  const next = ok(...args);
  assert.equal(next.baseHead, head);
  assert.equal(next.head, branchHead);
  assert.equal(ok('verification', '--record', '--dir', 'src', '--base', next.baseHead).base, head);
  fs.writeFileSync(path.join(repo, record), rounds);
  const headRef = snapshot.ref.replace(/\/tree$/, '/head');
  git('update-ref', '-d', headRef);
  assert.match(command(...args).stderr, /快照/);
  git('update-ref', headRef, head);
  git('update-ref', '-d', snapshot.ref);
  assert.match(command(...args).stderr, /快照/);
});

test('records concurrent rounds without losing BOM-prefixed legacy data or top-level fields', async t => {
  const { repo, output, run, base, args, git } = fixture(t);
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
  fs.writeFileSync(path.join(repo, 'new.js'), 'a different candidate');
  const snapshotRefs = () => git('for-each-ref', '--format=%(refname)', 'refs/bdd/worktree-snapshots');
  const refsBefore = snapshotRefs();
  run(2, '--record', '--base', base);
  assert.equal(snapshotRefs(), refsBefore);
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

test('records scoped scenario IDs and tracks dirty, new and changed features from any repository directory', t => {
  const { git, repo, base, output, run, args } = fixture(t);
  const module = '.bdd/modules/orders';
  const first = module + '/read.feature';
  const second = module + '/write.feature';
  const third = module + '/new.feature';
  fs.mkdirSync(path.join(repo, module), { recursive: true });
  fs.writeFileSync(path.join(repo, first), '功能: list\n@OR-01 @#1 @UI\n場景: 一\n@OR-02 @#1 @UI\n場景: 二\n');
  fs.writeFileSync(path.join(repo, second), 'Feature: write\n@OR-05 @#1 @API\nScenario: saved\n@OR-06 @#1 @API\nScenario: rejected\n');
  git('add', '.');
  git('commit', '-qm', 'features');
  const record = () => run(0, '--record', '--base', base, '--changed-scenarios', first,
    '--regression-scenarios', second + '::OR-05', '--passed', '3');
  const initial = record();
  assert.deepEqual(initial.scenarios, [
    { path: first, role: 'changed', ids: ['OR-01', 'OR-02'], blob: git('rev-parse', 'HEAD:' + first) },
    { path: second, role: 'regression', ids: ['OR-05'], blob: git('rev-parse', 'HEAD:' + second) },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'verification.json'))).rounds[0].scenarios, initial.scenarios);
  git('commit', '--allow-empty', '-qm', 'unrelated change');
  assert.equal(run(0, '--check').verdict, 'still-valid');
  fs.appendFileSync(path.join(repo, first), 'Then check new value\n');
  const nested = spawnSync(process.execPath, args('--check'), { cwd: path.join(repo, module), encoding: 'utf8' });
  assert.equal(nested.status, 1, nested.stderr);
  assert.deepEqual(JSON.parse(nested.stdout).dirtyPaths, [first]);
  const dirty = record();
  assert.deepEqual(dirty.dirtyPaths, [first]);
  assert.equal(dirty.scenarios[0].blob, initial.scenarios[0].blob);
  git('commit', '-qam', 'change selected scenario');
  const changed = run(1, '--check');
  assert.equal(changed.verdict, 'rerun');
  assert.deepEqual(changed.changedScenarios, [first]);
  fs.writeFileSync(path.join(repo, third), 'Feature: new\n@OR-09 @#2 @API\nScenario: nine\n');
  const fresh = run(0, '--record', '--base', base, '--changed-scenarios', third);
  assert.deepEqual(fresh.scenarios[0], { path: third, role: 'changed', ids: ['OR-09'], blob: null });
  run(2, '--record', '--base', base, '--changed-scenarios', module + '/missing.feature');
});

test('captured out-of-scope working changes still require a rerun after cleanup', t => {
  const { repo, base, run } = fixture(t);
  const extra = path.join(repo, 'local-settings.json');
  fs.writeFileSync(extra, '{}');
  const round = run(0, '--record', '--capture-revision', '--base', base);
  assert.equal(round.revision.head, base);
  assert.match(round.revision.dirtySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(round.dirtyPaths, []);
  fs.unlinkSync(extra);
  assert.equal(run(1, '--check').verdict, 'rerun');
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

test('mode-only changes invalidate both new and historical verification rounds', t => {
  const { repo, git, base, output, run } = fixture(t);
  git('config', 'core.filemode', 'false');
  fs.writeFileSync(path.join(repo, 'run.sh'), 'exit 0\n');
  git('add', 'run.sh');
  git('update-index', '--chmod=+x', '--', 'run.sh');
  git('commit', '-qm', 'add executable');
  const round = run(0, '--record', '--base', base);
  git('commit', '--allow-empty', '-qm', 'unchanged script');
  assert.equal(run(0, '--check').verdict, 'still-valid');
  git('update-index', '--chmod=-x', '--', 'run.sh');
  git('commit', '-qm', 'remove execute permission');
  assert.equal(round.files['run.sh'], git('rev-parse', 'HEAD:run.sh'));
  assert.deepEqual(run(1, '--check').changedFiles, ['run.sh']);
  assert.equal(round.fileModes['run.sh'], '100755');
  delete round.fileModes;
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ rounds: [round] }));
  assert.deepEqual(run(1, '--check').changedFiles, ['run.sh']);
  const nonExecutable = git('rev-parse', 'HEAD');
  git('switch', '--detach', base);
  git('restore', '--source', nonExecutable, '--staged', '--worktree', '--', 'run.sh');
  git('commit', '-qm', 'add script on a divergent branch');
  assert.deepEqual(run(1, '--check').changedFiles, ['run.sh']);
});

test('checks reachable commits in a batch and preserves order and duplicate explicit selections', t => {
  const { repo, git, output, run, args } = fixture(t);
  const commits = [];
  for (let n = 0; n < 4; n++) {
    git('commit', '--allow-empty', '-qm', 'round ' + n);
    commits.unshift(git('rev-parse', 'HEAD'));
  }
  commits.push(commits[1]);
  run(0, '--record', '--commits', commits.join(','));
  const trace = path.join(output, 'check-trace.ndjson');
  const checked = spawnSync(process.execPath, args('--check'), {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.deepEqual(JSON.parse(checked.stdout).commits.map(c => [c.source, c.status]), commits.map(sha => [sha, 'same']));
  const starts = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(row => JSON.parse(row))
    .filter(row => row.event === 'start').map(row => row.argv);
  const historyCalls = starts.filter(argv => ['cat-file', 'merge-base', 'rev-list'].some(cmd => argv.includes(cmd)));
  assert.ok(historyCalls.length <= 2, JSON.stringify(historyCalls));
});

test('verification rejects invalid result counts before appending a round', t => {
  const { repo, output, run, args, base } = fixture(t);
  const round = run(0, '--record', '--base', base, '--passed', '+3', '--failed', '1', '--blocked', '0');
  assert.deepEqual(round.result, { passed: 3, failed: 1, blocked: 0, notRun: 0 });
  const file = path.join(output, 'verification.json');
  const saved = fs.readFileSync(file);
  for (const [name, value] of [['passed', '-1'], ['failed', '-1'], ['blocked', '-1'], ['not-run', '-1'],
    ['passed', '1.5'], ['failed', '9007199254740992']]) {
    const res = spawnSync(process.execPath, args('--record', '--base', base, '--' + name + '=' + value),
      { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.ok(res.stderr.includes('--' + name), res.stderr);
    assert.deepEqual(fs.readFileSync(file), saved);
  }
});

test('verification records named engineering checks without feature files and keeps prior rounds unchanged', t => {
  const { repo, output, run, args, base } = fixture(t);
  const previous = run(0, '--record', '--base', base);
  assert.equal(Object.hasOwn(previous, 'engineeringChecks'), false);
  const selected = run(0, '--record', '--base', base, '--engineering-check', 'CLI-01',
    '--engineering-check', 'DB-02', '--passed', '2');
  assert.deepEqual(selected.engineeringChecks, ['CLI-01', 'DB-02']);
  assert.deepEqual(selected.scenarios, []);
  assert.equal(selected.result.passed, 2);
  assert.match(run(1, '--check').reasons.join(' '), /工程檢查/);
  const file = path.join(output, 'verification.json');
  const saved = fs.readFileSync(file);
  assert.deepEqual(JSON.parse(saved).rounds, [previous, selected]);
  for (const extra of [
    ['--record', '--base', base, '--engineering-check', ' '],
    ['--record', '--base', base, '--engineering-check', ' CLI-01'],
    ['--record', '--base', base, '--engineering-check', 'CLI-01', '--engineering-check', 'CLI-01'],
    ['--check', '--engineering-check', 'CLI-01'],
  ]) {
    const res = spawnSync(process.execPath, args(...extra), { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /--engineering-check/);
    assert.deepEqual(fs.readFileSync(file), saved);
  }
});

test('engineering assignment binds selected source paths to this checkout even with an empty commit range', t => {
  const { output, repo, git, run, args, base } = fixture(t);
  const guide = fs.readFileSync(new URL('../references/parallel-bdd-contract.md', import.meta.url), 'utf8');
  const assignment = JSON.parse(guide.match(/^```json\r?\n([\s\S]*?)\r?\n```/m)[1]);
  const check = (id, file) => ({ id, path: file, action: 'Inspect source', expected: 'Matches config', evidence: 'Log' });
  git('mv', 'readme', 'config.yml');
  git('commit', '-qm', 'replace config');
  const head = git('rev-parse', 'HEAD');
  assignment.scenarios = [];
  assignment.approvedPlan = { path: 'plan.json', sha256: 'a'.repeat(64) };
  assignment.engineeringChecks = [check('CFG', 'config.yml'), check('OLD', 'readme'), check('OTHER', 'other.yml')];
  assignment.target = { ...assignment.target, repo, workDir: repo, head };
  const file = path.join(output, 'assignment.json');
  const save = () => fs.writeFileSync(file, JSON.stringify(assignment));
  save();
  const flags = ['--record', '--base', head, '--engineering-check', 'OLD', '--engineering-check', 'CFG',
    '--engineering-assignment', file, '--passed', '2'];
  const round = run(0, ...flags);
  assert.deepEqual(round.engineeringSources, [{ id: 'OLD', path: 'readme' }, { id: 'CFG', path: 'config.yml' }]);
  assert.deepEqual(round.files, { readme: null, 'config.yml': git('rev-parse', 'HEAD:config.yml') });
  assert.deepEqual(round.fileModes, { readme: null, 'config.yml': '100644' });
  assert.equal(run(0, '--check').verdict, 'current');
  fs.writeFileSync(path.join(repo, 'other.yml'), 'unselected');
  git('add', 'other.yml');
  git('commit', '-qm', 'change unselected');
  assert.equal(run(0, '--check').verdict, 'still-valid');
  fs.writeFileSync(path.join(repo, 'readme'), 'reinstated');
  fs.appendFileSync(path.join(repo, 'config.yml'), 'updated');
  assert.deepEqual(run(1, '--check').dirtyPaths.sort(), ['config.yml', 'readme']);
  git('add', '.');
  git('commit', '-qm', 'change selected');
  assert.deepEqual(run(1, '--check').changedFiles.sort(), ['config.yml', 'readme']);
  git('switch', '--detach', head);
  fs.appendFileSync(path.join(repo, 'config.yml'), 'tested local change');
  assert.deepEqual(run(0, ...flags).dirtyPaths, ['config.yml']);
  git('restore', '--', 'config.yml');
  assert.equal(run(1, '--check').verdict, 'rerun');
  const recordFile = path.join(output, 'verification.json');
  for (const patch of [{ engineeringSources: [round.engineeringSources[0]] }, { files: {} }, { fileModes: {} }]) {
    fs.writeFileSync(recordFile, JSON.stringify({ rounds: [{ ...round, ...patch }] }));
    assert.match(run(1, '--check').reasons.join(' '), /工程檢查/);
  }
  const saved = fs.readFileSync(recordFile);
  const reject = (...extra) => {
    const res = spawnSync(process.execPath, args(...extra), { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.deepEqual(fs.readFileSync(recordFile), saved);
  };
  reject('--check', '--engineering-assignment', file);
  reject('--record', '--base', 'HEAD', '--engineering-assignment', file);
  reject(...flags, '--engineering-check', 'unknown');
  reject(...flags, '--head', base);
  assignment.target.head = base;
  save();
  reject(...flags);
  assignment.target.head = head;
  assignment.target.repo = output;
  save();
  reject(...flags);
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
  assert.deepEqual(round.files, { [name]: null, 'only-on-side': git('rev-parse', merge + ':only-on-side') });

  const queries = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.event === 'start').map(event => event.argv);
  assert.equal(queries.filter(argv => argv.includes('show') && argv.includes('--name-only')).length, 1);
  assert.equal(queries.filter(argv => argv.includes('log')).length, 1);
});

test('explicit merge selections track rename endpoints and recheck incomplete historical rounds', t => {
  const { repo, git, output, base, run } = fixture(t);
  git('switch', '-qc', 'topic');
  git('mv', 'readme', 'renamed');
  git('commit', '-qm', 'rename');
  git('switch', 'main');
  fs.writeFileSync(path.join(repo, 'main-only'), 'unselected');
  git('add', 'main-only');
  git('commit', '-qm', 'main change');
  git('merge', '--no-ff', '-qm', 'merge topic', 'topic');
  const merge = git('rev-parse', 'HEAD');
  const round = run(0, '--record', '--commits', merge);
  assert.deepEqual(round.files, { readme: null, renamed: git('rev-parse', 'HEAD:renamed') });
  assert.equal(run(0, '--check').verdict, 'current');
  fs.appendFileSync(path.join(repo, 'renamed'), 'changed');
  assert.deepEqual(run(1, '--check').dirtyPaths, ['renamed']);
  git('commit', '-qam', 'change merged file');
  assert.deepEqual(run(1, '--check').changedFiles, ['renamed']);
  const recordFile = path.join(output, 'verification.json');
  for (const scope of [{ fileScope: 'commits' }, { fileScope: undefined }, { fileScope: undefined, base }]) {
    const oldRound = { ...round, ...scope, files: {}, fileModes: {} };
    const historical = JSON.stringify({ rounds: [oldRound] });
    fs.writeFileSync(recordFile, historical);
    const checked = run(1, '--check');
    assert.deepEqual(checked.changedFiles, ['renamed']);
    assert.match(checked.reasons.join(' '), /未涵蓋.*readme.*renamed/);
    assert.equal(fs.readFileSync(recordFile, 'utf8'), historical);
  }
  git('switch', '--detach', merge);
  const same = run(1, '--check');
  assert.deepEqual(same.changedFiles, []);
  assert.match(same.reasons.join(' '), /未涵蓋/);
  fs.writeFileSync(path.join(repo, '.git', 'shallow'), merge + '\n');
  run(2, '--record', '--commits', merge);
  assert.match(run(1, '--check').reasons.join(' '), /無法重建/);
});

test('base rounds cover merge resolutions, rename endpoints and transient paths at the tested HEAD', t => {
  const { repo, git, base, run, output } = fixture(t);
  const write = (name, value) => fs.writeFileSync(path.join(repo, name), value);
  git('switch', '-qc', 'side');
  write('component.js', 'component');
  git('add', '.');
  git('commit', '-qm', 'side');
  const component = git('rev-parse', 'HEAD');
  git('switch', 'main');
  write('service.js', 'service');
  git('add', '.');
  git('commit', '-qm', 'main');
  git('merge', '--no-commit', '--no-ff', 'side');
  git('mv', 'readme', 'renamed');
  write('policy.js', 'integration');
  write('temporary', 'only at first merge');
  git('add', '.');
  git('commit', '-qm', 'integrate');
  const merge = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'more');
  git('commit', '--allow-empty', '-qm', 'other');
  git('switch', 'main');
  git('merge', '--no-commit', '--no-ff', 'more');
  git('rm', '-q', 'temporary');
  git('commit', '-qm', 'finish integration');
  const head = git('rev-parse', 'HEAD');

  const round = run(0, '--record', '--base', base);
  assert.deepEqual(Object.keys(round.files).sort(), ['component.js', 'policy.js', 'readme', 'renamed', 'service.js', 'temporary']);
  assert.equal(round.files.readme, null);
  assert.equal(round.files.temporary, null);
  assert.equal(round.files['policy.js'], git('rev-parse', head + ':policy.js'));
  assert.ok(!round.commits.some(c => [merge, head].includes(c.sha)));
  assert.equal(run(0, '--check').verdict, 'current');
  write('policy.js', 'updated');
  assert.deepEqual(run(1, '--check').dirtyPaths, ['policy.js']);
  git('commit', '-qam', 'change integration policy');
  assert.deepEqual(run(1, '--check').changedFiles, ['policy.js']);
  assert.deepEqual(run(0, '--record', '--base', base, '--head', head).files, round.files);

  // v3.2.0 stored only the non-merge paths and lacked provenance for omitted working-tree files.
  const old = { ...round, files: { 'component.js': round.files['component.js'], 'service.js': round.files['service.js'] } };
  delete old.fileScope;
  const recordFile = path.join(output, 'verification.json');
  const historical = JSON.stringify({ rounds: [old] });
  fs.writeFileSync(recordFile, historical);
  const checked = run(1, '--check');
  assert.deepEqual(checked.changedFiles, ['policy.js']);
  assert.equal(checked.verdict, 'rerun');
  assert.equal(fs.readFileSync(recordFile, 'utf8'), historical);
  git('switch', '--detach', head);
  assert.equal(run(1, '--check').verdict, 'rerun');

  const selected = run(0, '--record', '--base', base, '--commits', component);
  assert.deepEqual(Object.keys(selected.files), ['component.js']);
  assert.equal(run(0, '--check').verdict, 'current');
  delete selected.fileScope;
  fs.writeFileSync(recordFile, JSON.stringify({ rounds: [selected] }));
  assert.equal(run(0, '--check').verdict, 'current');

  fs.writeFileSync(recordFile, JSON.stringify({ rounds: [{ ...old, base: 'f'.repeat(40) }] }));
  const unavailable = run(1, '--check');
  assert.match(unavailable.reasons.join(' '), /無法重建/);
});

test('base coverage includes a parent resolution in the net diff from the common ancestor', t => {
  const { repo, git, run } = fixture(t);
  git('switch', '-qc', 'upstream');
  fs.writeFileSync(path.join(repo, 'upstream-policy'), 'incoming');
  git('add', '.');
  git('commit', '-qm', 'upstream policy');
  git('switch', 'main');
  fs.writeFileSync(path.join(repo, 'feature'), 'feature');
  git('add', '.');
  git('commit', '-qm', 'feature');
  // Keep the first parent's tree, excluding the policy that exists in the incoming base.
  git('merge', '-q', '-s', 'ours', 'upstream', '-m', 'integrate');
  git('switch', 'upstream');
  fs.writeFileSync(path.join(repo, 'unrelated-upstream'), 'later');
  git('add', '.');
  git('commit', '-qm', 'unrelated');
  git('switch', 'main');
  const round = run(0, '--record', '--base', 'upstream');
  assert.deepEqual(Object.keys(round.files).sort(), ['feature', 'upstream-policy']);
  assert.equal(round.files['upstream-policy'], null);
  assert.equal(run(0, '--check').verdict, 'current');
});

test('two merges that adopt and restore a parent version keep the intermediate path in scope', t => {
  const { repo, git, base, run } = fixture(t);
  git('switch', '-qc', 'upstream');
  fs.writeFileSync(path.join(repo, 'readme'), 'upstream\n');
  git('commit', '-qam', 'change upstream');
  const firstUpstream = git('rev-parse', 'HEAD');
  git('restore', '--source', base, '--', 'readme');
  git('commit', '-qam', 'restore upstream');
  const secondUpstream = git('rev-parse', 'HEAD');

  git('switch', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'feature');
  git('merge', '--no-ff', '-qm', 'adopt upstream change', firstUpstream);
  git('merge', '--no-ff', '-qm', 'adopt upstream restoration', secondUpstream);
  assert.equal(git('diff', '--name-only', secondUpstream + '...HEAD'), '');
  const round = run(0, '--record', '--base', secondUpstream);
  assert.deepEqual(round.commits.map(c => c.subject), ['feature']);
  assert.deepEqual(round.files, { readme: git('rev-parse', 'HEAD:readme') });
  fs.writeFileSync(path.join(repo, 'readme'), 'changed again\n');
  git('commit', '-qam', 'change after the test');
  assert.deepEqual(run(1, '--check').changedFiles, ['readme']);
});

test('a shallow boundary inside a base range cannot stand in for complete historical coverage', t => {
  const { repo, git, run, output, base, args } = fixture(t);
  git('commit', '--allow-empty', '-qm', 'first');
  git('commit', '--allow-empty', '-qm', 'second');
  const round = run(0, '--record', '--base', base);
  // Both endpoints exist locally, as after separate depth-limited fetches.
  fs.writeFileSync(path.join(repo, '.git', 'shallow'), round.head + '\n');
  assert.equal(git('rev-list', '--count', base + '..HEAD'), '1');
  const truncated = spawnSync(process.execPath, args('--record', '--base', base), { cwd: repo, encoding: 'utf8' });
  assert.equal(truncated.status, 2);
  assert.match(truncated.stderr, /提交歷程不完整/);
  const legacy = { ...round };
  delete legacy.fileScope;
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ rounds: [legacy] }));
  assert.match(run(1, '--check').reasons.join(' '), /無法重建/);
});
