import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './verification-fixture.mjs';

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
  assert.equal(run(0, '--check').verdict, 'current');
  git('commit', '--allow-empty', '-qm', 'unrelated later commit');
  const trace = path.join(output, 'check-trace.ndjson');
  const checked = spawnSync(process.execPath, args('--check'), {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.equal(JSON.parse(checked.stdout).verdict, 'still-valid');
  assert.deepEqual(JSON.parse(checked.stdout).commits.map(c => [c.source, c.status]), commits.map(sha => [sha, 'same']));
  const starts = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(row => JSON.parse(row))
    .filter(row => row.event === 'start').map(row => row.argv);
  const historyCalls = starts.filter(argv => ['cat-file', 'merge-base', 'rev-list'].some(cmd => argv.includes(cmd)));
  assert.ok(historyCalls.length <= 2, JSON.stringify(historyCalls));
});

test('unreachable commits without patch IDs use subjects and only mixed patches need history diffs', t => {
  const { repo, output, git, base, run, args } = fixture(t);
  git('commit', '--allow-empty', '-qm', 'release marker');
  const marker = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qm', 'removed marker');
  const missing = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'change'), 'tested\n');
  git('add', 'change');
  git('commit', '-qm', 'tested change');
  const change = git('rev-parse', 'HEAD');
  const round = run(0, '--record', '--commits', [base, marker, missing, change].join(','));
  const [ancestor, empty, removed, patch] = round.commits;
  assert.ok(ancestor.patchId && patch.patchId);
  assert.equal(empty.patchId, '');
  assert.equal(removed.patchId, '');
  git('switch', '-qc', 'rewritten', base);
  git('cherry-pick', '--no-commit', change);
  git('commit', '-qm', 'release marker');
  const replacement = git('rev-parse', 'HEAD');

  function check(name, commits, expected, pipelines) {
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ rounds: [{ ...round, commits }] }));
    const trace = path.join(output, name + '.ndjson');
    const checked = spawnSync(process.execPath, args('--check'), {
      cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
    });
    assert.equal(checked.status, 1, checked.stderr + checked.stdout);
    assert.deepEqual(JSON.parse(checked.stdout).commits.map(c => [c.source, c.status, c.target]), expected);
    const commands = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'start').map(event => event.argv);
    assert.equal(commands.filter(argv => argv.includes('show') && argv.includes('--patch')).length, pipelines);
    assert.equal(commands.filter(argv => argv.includes('patch-id')).length, pipelines);
  }
  check('subjects', [ancestor, empty, removed], [[base, 'same', base], [marker, 'subject', replacement], [missing, 'missing', null]], 0);
  check('mixed', [empty, patch], [[marker, 'subject', replacement], [change, 'patch', replacement]], 1);
});

test('mixed and truncated histories classify original SHAs, tag objects and missing objects independently', t => {
  const { repo, output, git, base, run, args } = fixture(t);
  // A single import keeps the deep history inexpensive on Windows.
  const history = Array.from({ length: 48 }, (_, index) => {
    const n = index + 1;
    return ['commit refs/heads/tested', 'mark :' + n, 'committer Fixture <fixture@example.invalid> ' + (1700000000 + n) + ' +0000',
      'data <<END', 'tested ' + n, 'END', 'from ' + (index ? ':' + index : base),
      'M 100644 inline readme', 'data <<END', String(n), 'END', '', ''].join('\n');
  });
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: history.join('') + 'done\n' });
  git('switch', '-q', 'tested');
  const chain = git('rev-list', '--reverse', base + '..HEAD').split(/\r?\n/);
  const selected = [1, 8, 11, 46, 47, 48].map(n => chain[n - 1]);
  const round = run(0, '--record', '--commits', selected.join(','));
  git('tag', '-a', '--no-sign', 'inside', selected[1], '-m', 'ancestor');
  git('tag', '-a', '--no-sign', 'outside', selected[5], '-m', 'divergent');
  round.commits.push({ ...round.commits[1], sha: git('rev-parse', 'inside') },
    { ...round.commits[5], sha: git('rev-parse', 'outside') }, { ...round.commits[5], sha: selected[5].toUpperCase() },
    { sha: '0'.repeat(base.length), subject: 'absent object', patchId: '' },
    { sha: git('rev-parse', 'HEAD:readme'), subject: 'not a commit', patchId: '' });
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ rounds: [round] }));

  function checkFork(branch, from, expected, fallbackShas) {
    git('switch', '-qc', branch, from);
    git('commit', '--allow-empty', '-qm', branch);
    const trace = path.join(output, branch + '.ndjson');
    const checked = spawnSync(process.execPath, args('--check'), {
      cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
    });
    assert.equal(checked.status, 1, checked.stdout + checked.stderr);
    const result = JSON.parse(checked.stdout);
    assert.equal(result.verdict, 'rerun');
    assert.ok(result.reasons.includes('目前 HEAD 並非由受測版本前進'));
    assert.deepEqual(result.commits.map(c => c.source), round.commits.map(c => c.sha));
    assert.deepEqual(result.commits.map(c => c.status), expected);
    const calls = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
      .filter(event => event.event === 'start').map(event => event.argv);
    assert.equal(calls.filter(argv => argv.includes('cat-file') && argv.includes('-e')).length, 0);
    assert.equal(calls.filter(argv => argv.includes('rev-list')).length, 1);
    assert.deepEqual(calls.filter(argv => argv.includes('--is-ancestor')).map(argv => argv.at(-2)).sort(), fallbackShas.sort());
  }
  checkFork('one-diverged', chain[46], ['same', 'same', 'same', 'same', 'same', 'missing', 'same', 'missing', 'missing', 'missing', 'missing'], []);
  // Outside this older fork, commit 11 lies beyond the bounded page and is still missing.
  checkFork('deep-fork', chain[7], ['same', 'same', 'missing', 'missing', 'missing', 'missing', 'same', 'missing', 'missing', 'missing', 'missing'],
    [selected[0], selected[1], selected[2]]);
});

test('records touched paths and ordered subjects with one Git query each across explicit commits', t => {
  const { repo, output, git, args } = fixture(t);
  git('config', 'core.logAllRefUpdates', 'true');
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

  git('tag', '-a', '--no-sign', '測試/baseline', add, '-m', 'feature baseline');
  const references = ['HEAD^1', 'HEAD', '測試/baseline', remove, 'HEAD@{0}'];
  const selected = [remove, merge, add, remove, merge];
  const trace = path.join(output, 'git-trace.ndjson');
  const res = spawnSync(process.execPath, args('--record', '--commits', references.join(',')), {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const round = JSON.parse(res.stdout);
  assert.deepEqual(round.commits.map(c => c.sha), selected);
  assert.deepEqual(round.commits.map(c => c.subject), ['remove', 'merge side', '加入暫存檔', 'remove', 'merge side']);
  assert.deepEqual(round.files, { [name]: null, 'only-on-side': git('rev-parse', merge + ':only-on-side') });

  const queries = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.event === 'start').map(event => event.argv);
  assert.equal(queries.filter(argv => argv.includes('show') && argv.includes('--name-only')).length, 1);
  assert.equal(queries.filter(argv => argv.includes('log')).length, 1);
  assert.equal(queries.filter(argv => argv.includes('cat-file') && argv.some(a => a.startsWith('--batch-check'))).length, 1);
  assert.ok(queries.filter(argv => argv.includes('rev-parse') && argv.includes('--verify')).length <= 2);

  const record = path.join(output, 'verification.json');
  const published = fs.readFileSync(record);
  for (const invalid of ['no-such-commit', git('rev-parse', merge + ':only-on-side'), '--not-a-revision']) {
    const rejected = spawnSync(process.execPath, args('--record', '--commits', 'HEAD,' + invalid + ',' + add), {
      cwd: repo, encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(fs.readFileSync(record), published);
  }
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
