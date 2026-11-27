import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { changedPaths } from '../scripts/lib/git-changes.mjs';
import { cli, fixture } from './verification-fixture.mjs';

const runAsync = promisify(execFile);

test('verification reads checkout metadata once per command and preserves detached and ambiguous HEADs', t => {
  const { repo, output, git, base, args, run } = fixture(t);
  const nested = path.join(repo, 'child');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'HEAD'), 'file with the same name as the revision');
  git('switch', '-qc', 'topic/metadata');
  const trace = path.join(output, 'checkout.jsonl');
  const fromChild = (...options) => JSON.parse(execFileSync(process.execPath, args(...options), {
    cwd: nested, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  }));
  const round = fromChild('--record', '--base', 'HEAD');
  assert.equal(round.branch, 'topic/metadata');
  assert.equal(round.head, base);
  const { current } = fromChild('--check', '--brief');
  assert.deepEqual(current, { repo: round.repo, branch: round.branch, head: base });
  const commands = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.event === 'start').map(event => event.argv);
  const metadata = commands.filter(argv => argv.includes('--show-toplevel') || argv.includes('HEAD^{commit}') || argv.includes('--show-current'));
  assert.equal(metadata.length, 2, JSON.stringify(metadata));

  git('commit', '--allow-empty', '-qm', 'later');
  const later = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/tags/HEAD', base);
  git('config', 'core.warnAmbiguousRefs', 'true');
  assert.deepEqual(run(0, '--check').current, { ...current, head: later });
  const historical = run(0, '--record', '--head', base, '--base', 'HEAD');
  assert.equal(historical.head, base);
  assert.equal(historical.base, later);
  assert.equal(historical.branch, round.branch);
  git('update-ref', '-d', 'refs/tags/HEAD');
  git('switch', '--detach', '-q', base);
  assert.deepEqual(run(0, '--check').current, { ...current, branch: '' });
  git('update-ref', 'refs/tags/nonbranch', base);
  git('symbolic-ref', 'HEAD', 'refs/tags/nonbranch');
  const invalid = spawnSync(process.execPath, args('--check'), { cwd: nested, encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /refs\/heads/);
});

test('recorded worktrees retain rollback, untracked and scenario deltas across same-HEAD feedback', t => {
  const { repo, output, git, base } = fixture(t);
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
  const headRef = snapshot.ref.replace(/\/tree$/, '/head');
  const trace = path.join(output, 'snapshot-refs.ndjson');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).paths, []); // Unchanged untracked and staged-only versions are excluded.
  const refQueries = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.event === 'start' && (event.argv.includes(snapshot.ref) || event.argv.includes(headRef)));
  assert.equal(refQueries.length, 1);
  assert.ok(refQueries[0].argv.includes(snapshot.ref) && refQueries[0].argv.includes(headRef));

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
  function assertInvalidRefs() {
    const result = command(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /所在 Git 儲存庫找不到上一輪登記的工作樹快照/);
  }
  git('update-ref', headRef, branchHead);
  assertInvalidRefs();
  git('update-ref', '-d', headRef);
  assertInvalidRefs();
  git('update-ref', headRef, head);
  git('update-ref', snapshot.ref, git('rev-parse', branchHead + '^{tree}'));
  assertInvalidRefs();
  git('update-ref', '-d', snapshot.ref);
  assertInvalidRefs();
});

test('records concurrent rounds without losing BOM-prefixed legacy data or top-level fields', async t => {
  const { repo, output, run, base, args, git } = fixture(t);
  const file = path.join(output, 'verification.json');
  assert.equal(run(2, '--check').verdict, 'no-record');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ source: 'legacy', rounds: [{ note: 'preserve' }] }));
  const notes = ['one', 'two', 'three'];
  const outputs = await Promise.all(notes.map((note, i) => runAsync(process.execPath,
    [cli, 'verification', '--dir', path.relative(repo, output), '--record', '--base', base, '--note', note,
      '--passed', String(i), '--failed', '1', ...(i < 2 ? ['--brief'] : []), ...(i === 0 ? ['--capture-revision'] : [])],
    { cwd: repo }).then(command => JSON.parse(command.stdout))));
  const doc = JSON.parse(fs.readFileSync(file));
  assert.equal(doc.source, 'legacy');
  assert.equal(doc.rounds[0].note, 'preserve');
  assert.deepEqual(doc.rounds.slice(1).map(r => r.note).sort(), ['one', 'three', 'two']);
  for (const [i, note] of notes.entries()) {
    const roundIndex = doc.rounds.findIndex(r => r.note === note);
    const round = doc.rounds[roundIndex];
    if (i === 2) assert.deepEqual(outputs[i], round);
    else {
      const { verificationPath, ...receipt } = outputs[i];
      assert.ok(path.isAbsolute(verificationPath));
      assert.equal(fs.realpathSync(verificationPath), fs.realpathSync(file));
      assert.deepEqual(receipt, { roundIndex, head: base, result: round.result, dirtyPathCount: 0,
        ...(i === 0 ? { dirtySha256: null } : {}) });
    }
    assert.equal(round.result.failed, 1);
    assert.ok(round.worktreeSnapshot);
  }
  delete doc.rounds.at(-1).scenarios;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.equal(run(0, '--check').verdict, 'current');
  const malformed = '{"rounds":{}}';
  fs.writeFileSync(file, malformed);
  fs.writeFileSync(path.join(repo, 'new.js'), 'a different candidate');
  const snapshotRefs = () => git('for-each-ref', '--format=%(refname)', 'refs/bdd/worktree-snapshots');
  const refsBefore = snapshotRefs();
  assert.equal(run(2, '--record', '--brief', '--base', base), '');
  assert.equal(snapshotRefs(), refsBefore);
  assert.equal(fs.readFileSync(file, 'utf8'), malformed);
  assert.deepEqual(fs.readdirSync(output), ['verification.json']);
});

test('brief checks retain the recorded outcome and return full diagnostics when verification must rerun', t => {
  const { repo, git, base, run } = fixture(t);
  const check = (code, ...flags) => run(code, '--check', ...flags);
  assert.deepEqual(check(2, '--brief'), check(2));
  const source = path.join(repo, 'amount');
  fs.writeFileSync(source, 'first');
  git('add', 'amount');
  git('commit', '-qm', 'first change');
  fs.writeFileSync(source, 'second');
  git('commit', '-qam', 'second change');
  run(0, '--record', '--base', base, '--passed', '2', '--failed', '1');
  for (const verdict of ['current', 'still-valid']) {
    if (verdict === 'still-valid') git('commit', '--allow-empty', '-qm', 'later commit');
    const full = check(0);
    assert.equal(full.verdict, verdict);
    assert.deepEqual(full.commits.map(commit => commit.status), ['same', 'same']);
    assert.equal(full.recorded.result.failed, 1);
    assert.deepEqual(check(0, '--brief'), { verdict, recorded: full.recorded, current: full.current, sameCommitCount: 2 });
  }
  fs.appendFileSync(source, 'edited');
  const dirty = check(1);
  assert.deepEqual(dirty.dirtyPaths, ['amount']);
  assert.deepEqual(check(1, '--brief'), dirty);
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

test('historical record batches unique Feature blobs and preserves scenario roles and input order', t => {
  const { repo, output, git, base, args, run } = fixture(t);
  const dir = '.bdd/modules/sample';
  fs.mkdirSync(path.join(repo, dir), { recursive: true });
  const first = dir + (process.platform === 'win32' ? '/[訂單] A.feature' : '/[訂單]\nA.feature');
  const alias = dir + '/same.feature', second = dir + '/other.feature';
  const feature = id => 'Feature: 訂單\n' + id.map(n => '@OR-' + n + ' @#42 @API\nScenario: 狀態 ' + n).join('\n');
  for (const file of [first, alias]) fs.writeFileSync(path.join(repo, file), feature(['01', '02']));
  fs.writeFileSync(path.join(repo, second), feature(['03']));
  // Recorded product paths and scenario paths together cross the Windows Git argument batch boundary.
  for (let i = 0; i < 130; i++) fs.writeFileSync(path.join(repo, 'p'.repeat(94) + i), '');
  git('add', '.');
  const linkPath = dir + '/link.feature', submodule = dir + '/nested';
  const linkBlob = git('rev-parse', 'HEAD:readme');
  git('update-index', '--add', '--cacheinfo', '120000', linkBlob, linkPath);
  git('update-index', '--add', '--cacheinfo', '160000', base, submodule);
  git('commit', '-qm', 'tested Features');
  const tested = git('rev-parse', 'HEAD');
  const firstBlob = git('rev-parse', tested + ':' + first);
  const secondBlob = git('rev-parse', tested + ':' + second);
  fs.writeFileSync(path.join(repo, first), feature(['99']));
  fs.unlinkSync(path.join(repo, alias));
  git('add', '-u');
  git('commit', '-qm', 'newer Features');
  const changed = [second, first + '::OR-02,or-01', alias + '::OR-01', second, linkPath].join(';');
  const trace = path.join(output, 'historical-trace.ndjson');
  const result = spawnSync(process.execPath, args('--record', '--head', tested, '--base', base, '--changed-scenarios',
    changed, '--regression-scenarios', first + '::OR-01'), {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  const round = JSON.parse(result.stdout);
  assert.deepEqual(round.scenarios.map(s => [s.path, s.blob, s.ids, s.role]), [
    [second, secondBlob, ['OR-03'], 'changed'], [first, firstBlob, ['OR-02', 'or-01'], 'changed'],
    [alias, firstBlob, ['OR-01'], 'changed'], [second, secondBlob, ['OR-03'], 'changed'],
    [linkPath, linkBlob, [], 'changed'], [first, firstBlob, ['OR-01'], 'regression'],
  ]);
  assert.equal(Object.keys(round.files).length, 130);
  assert.equal(round.worktreeSnapshot, undefined);
  const queries = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.event === 'start').map(event => event.argv);
  assert.equal(queries.filter(argv => argv.includes('ls-tree')).length, 2);
  assert.deepEqual(queries.filter(argv => argv.includes('cat-file')).map(argv => argv.at(-1)), ['--batch']);

  // A single legacy ./ spelling is resolved by Git's revision:path syntax.
  const legacy = run(0, '--record', '--head', tested, '--base', tested, '--changed-scenarios', '././' + alias);
  assert.deepEqual(legacy.scenarios, [{ path: './' + alias, blob: null, ids: ['OR-01', 'OR-02'], role: 'changed' }]);
  const single = run(0, '--record', '--head', tested, '--base', tested, '--regression-scenarios', first + '::OR-01');
  assert.deepEqual(single.scenarios, [{ path: first, blob: firstBlob, ids: ['OR-01'], role: 'regression' }]);
  const published = fs.readFileSync(path.join(output, 'verification.json'));
  for (const invalid of [dir + '/absent.feature', second + '::OR-99', dir, submodule, second.replace('/other', '//other')]) {
    const rejected = spawnSync(process.execPath, args('--record', '--head', tested, '--base', tested,
      '--changed-scenarios', first + ';' + invalid), { cwd: repo, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0, invalid);
    assert.deepEqual(fs.readFileSync(path.join(output, 'verification.json')), published);
  }
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

test('same resolved commits skip empty Git ranges and keep working, staged and explicit scopes', t => {
  const { repo, git, base, output, args, run } = fixture(t);
  git('config', 'core.longpaths', 'true');
  fs.writeFileSync(path.join(repo, 'readme'), 'staged\n');
  git('add', 'readme');
  fs.writeFileSync(path.join(repo, 'readme'), 'base\n');
  fs.writeFileSync(path.join(repo, 'new.feature'), 'Feature: Order\n@OR-01\nScenario: placed\n');
  const trace = path.join(output, 'ranges.ndjson');
  function traced(argv, trace) {
    const result = spawnSync(process.execPath, argv, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const commands = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(e => e.event === 'start').map(e => e.argv);
  const record = traced(args('--record', '--base', 'HEAD', '--changed-scenarios', 'new.feature::OR-01'), trace);
  assert.deepEqual(record.commits, []);
  assert.deepEqual(record.scenarios[0].ids, ['OR-01']);
  assert.deepEqual(record.dirtyPaths, ['new.feature']);
  const planTrace = path.join(output, 'preview.ndjson');
  const receipt = traced([cli, 'quality-plan', '--base', 'HEAD', '--review-reason', 'reviewed',
    '--preview-output', path.join(output, 'plan.json')], planTrace);
  const plan = JSON.parse(fs.readFileSync(receipt.previewPath, 'utf8'));
  assert.deepEqual(plan.paths, ['new.feature', 'readme']);
  const previewQueries = commands(planTrace);
  const recordQueries = commands(trace);
  assert.ok(![...recordQueries, ...previewQueries].some(argv => argv.includes(base + '..' + base) || argv.includes(base + '...' + base)));
  assert.equal(recordQueries.filter(argv => argv.includes('HEAD^{commit}')).length, 1);
  assert.equal(previewQueries.filter(argv => argv.includes('HEAD^{commit}')).length, 1);
  assert.equal(previewQueries.filter(argv => argv.includes('--show-toplevel')).length, 1);
  const explicit = run(0, '--record', '--base', 'HEAD', '--commits', 'HEAD');
  assert.deepEqual(explicit.commits.map(entry => entry.sha), [base]);
  assert.ok(Object.hasOwn(explicit.files, 'readme'));
  const missing = '1'.repeat(base.length);
  const legacy = { ...record, base: missing, head: missing };
  delete legacy.fileScope;
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ rounds: [legacy] }));
  assert.ok(run(1, '--check').reasons.some(reason => reason.includes('無法重建舊驗證紀錄的受測範圍')));
});

test('quality-plan reads ordinary staged, working and untracked paths in one status without updating the index', t => {
  const { repo, output, git, base } = fixture(t);
  const write = (file, text) => fs.writeFileSync(path.join(repo, file), text);
  write('.gitignore', '*.local\n');
  for (const name of ['old name', 'staged-delete', 'working-delete', 'staged-and-restored']) write(name, 'initial\n');
  git('add', '.');
  git('commit', '-qm', 'prepare statuses');
  const head = git('rev-parse', 'HEAD');
  git('mv', 'old name', 'new [name]');
  git('rm', '-q', 'staged-delete');
  fs.unlinkSync(path.join(repo, 'working-delete'));
  write('staged-and-restored', 'index\n');
  git('add', 'staged-and-restored');
  write('staged-and-restored', 'initial\n');
  write('intent-to-add', 'new\n');
  git('add', '-N', 'intent-to-add');
  write('untouched.local', 'ignored\n');
  write('  空 白.txt', 'untracked\n');
  git('config', 'status.showUntrackedFiles', 'no');
  git('config', 'status.renames', 'true');
  const index = path.join(repo, '.git', 'index');
  const before = fs.statSync(index, { bigint: true }).mtimeNs;
  const trace = path.join(output, 'quality-status.ndjson');
  const result = spawnSync(process.execPath, [cli, 'quality-plan', '--base', base, '--review-reason', 'inspect changes'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(index, { bigint: true }).mtimeNs, before);
  const paths = ['.gitignore', 'old name', 'new [name]', 'staged-delete', 'working-delete', 'staged-and-restored',
    'intent-to-add', '  空 白.txt'].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(JSON.parse(result.stdout).paths, paths);
  const starts = fs.readFileSync(trace, 'utf8').trim().split('\n').map(row => JSON.parse(row))
    .filter(e => e.event === 'start').map(e => e.argv);
  assert.equal(starts.filter(args => args.includes('--porcelain=v2')).length, 1);
  assert.deepEqual(starts.filter(args => args.includes('diff') || args.includes('ls-files')).map(args => args.at(-2)),
    [base + '...' + head]);
});

test('quality-plan retains the pinned HEAD, submodule ignore and deleted intent-to-add semantics', t => {
  const { repo, git, base } = fixture(t);
  const file = name => path.join(repo, name);
  fs.writeFileSync(file('later'), 'committed later\n');
  git('add', 'later');
  git('commit', '-qm', 'new HEAD');
  const head = git('rev-parse', 'HEAD');
  assert.deepEqual(changedPaths(repo, base, base), ['later']);
  fs.writeFileSync(file('intent'), 'uncommitted\n');
  git('add', '-N', 'intent');
  fs.unlinkSync(file('intent'));
  assert.deepEqual(changedPaths(repo, head, head), []);
  git('reset', '-q', '--', 'intent');
  const blob = git('rev-parse', 'HEAD:readme');
  execFileSync('git', ['-C', repo, 'update-index', '--index-info'], {
    input: '0 ' + '0'.repeat(blob.length) + '\treadme\n100644 ' + blob + ' 1\treadme\n100644 ' + blob + ' 2\treadme\n',
  });
  assert.deepEqual(changedPaths(repo, head, head), ['readme']);
  git('reset', '-q', '--', 'readme');

  // The pinned diffs honor the project's submodule ignore configuration.
  git('init', '-q', 'nested');
  fs.writeFileSync(file('nested/readme'), 'clean child\n');
  git('-C', 'nested', 'add', 'readme');
  git('-C', 'nested', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'child');
  fs.writeFileSync(file('.gitmodules'), '[submodule "nested"]\n\tpath = nested\n\turl = ../repo\n');
  git('add', '.gitmodules', 'nested');
  git('commit', '-qm', 'commit gitlink');
  const nestedHead = git('rev-parse', 'HEAD');
  fs.writeFileSync(file('nested/readme'), 'dirty child\n');
  git('config', 'submodule.nested.ignore', 'all');
  assert.deepEqual(changedPaths(repo, nestedHead, nestedHead), []);
  git('config', 'submodule.nested.ignore', 'none');
  assert.deepEqual(changedPaths(repo, nestedHead, nestedHead), ['nested']);
});

test('quality-plan retains the order of distinct paths with equal collation', t => {
  const { repo, git } = fixture(t);
  const first = 'caf\u00e9', second = 'cafe\u0301';
  const write = (file, text) => fs.writeFileSync(path.join(repo, file), text);
  for (const name of [first, second]) write(name, 'base\n');
  const names = fs.readdirSync(repo);
  if (!names.includes(first) || !names.includes(second)) return t.skip('File system folds equivalent Unicode names');
  git('add', '.');
  git('commit', '-qm', 'two distinct Unicode paths');
  const head = git('rev-parse', 'HEAD');
  write(second, 'staged\n');
  git('add', '--', second);
  write(second, 'base\n');
  write(first, 'unstaged\n');
  assert.deepEqual(changedPaths(repo, head, head), [first, second]);
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
  const guide = fs.readFileSync(new URL('../references/parallel-contract-examples.md', import.meta.url), 'utf8');
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
