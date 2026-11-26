import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareApprovedPlan, loadApprovedPlan } from '../scripts/lib/parallel-plan.mjs';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const guide = fs.readFileSync(new URL('../references/parallel-bdd-contract.md', import.meta.url), 'utf8');
const example = JSON.parse(guide.match(/^```json\r?\n([\s\S]*?)\r?\n```/m)[1]);
const writeJson = (file, value) => fs.writeFileSync(file, '\uFEFF' + JSON.stringify(value));

test('engineering-only feedback can be reviewed and assigned with its changed paths and exact checks', t => {
  const { dir, repo, git, file, plan, template, run } = fixture(t);
  const scenario = plan.groups[0].scenarios[0];
  const feature = scenario.feature;
  fs.writeFileSync(path.join(repo, feature), 'Feature: Orders\n@OR-01 @#42 @API\nScenario: Read order\n');
  fs.writeFileSync(path.join(repo, path.dirname(feature), 'MODULE.md'), '---\nprefix: OR\npaths:\n  - orders/**\n---\n');
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'checks');
  git('add', '-f', '--', '.bdd');
  commit();
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'build.yml'), 'jobs: [test]\n');
  git('add', '--', 'build.yml');
  commit();
  const checks = [{ id: 'build-matrix', path: 'build.yml', action: 'Run the matrix', expected: 'All jobs pass', evidence: 'Job logs' }];
  const input = path.join(dir, 'checks.json');
  const source = path.join(dir, 'selection.json');
  const quality = (...args) => spawnSync(process.execPath, [cli, 'quality-plan', '--repo', repo, '--base', base, '--issue', '42',
    '--review-reason', 'Only the build changed', '--static-passed', '--impact-complete', '--engineering-checks', input, ...args],
  { encoding: 'utf8' });
  writeJson(input, checks);
  const selection = quality('--run-id', plan.runId, '--output', source);
  assert.equal(selection.status, 0, selection.stderr);
  const selected = JSON.parse(fs.readFileSync(source));
  assert.equal(selected.bddStatus, 'PENDING');
  assert.deepEqual(selected.selected, []);
  assert.deepEqual(selected.engineeringChecks, checks);
  plan.scope = 'batch';
  plan.selections = [JSON.parse(selection.stdout)];
  plan.groups = [{ ...plan.groups[0], revision: selected.revision, scenarios: [], engineeringChecks: checks }];
  writeJson(file, plan);
  const report = run('--report');
  assert.equal(report.status, 0, report.stderr);
  for (const value of Object.values(checks[0])) assert.ok(report.stdout.includes(value), value);
  template.target.head = selected.head;
  const templateFile = path.join(dir, 'template.json');
  writeJson(templateFile, template);
  const assignment = run('--template', templateFile);
  assert.equal(assignment.status, 0, assignment.stderr);
  const assigned = JSON.parse(assignment.stdout);
  assert.deepEqual(assigned.engineeringChecks, checks);
  const assignedFile = path.join(dir, 'assignment.json');
  writeJson(assignedFile, assigned);
  assert.equal(run('--assignment', assignedFile).status, 0);
  assigned.engineeringChecks[0].expected = 'Starts a job';
  writeJson(assignedFile, assigned);
  assert.notEqual(run('--assignment', assignedFile).status, 0);
  plan.groups[0].engineeringChecks = assigned.engineeringChecks;
  writeJson(file, plan);
  assert.notEqual(run('--report').status, 0);
  for (const invalid of [[], [checks[0], checks[0]], [{ ...checks[0], action: ' ' }], [{ ...checks[0], path: 'unchanged.yml' }]]) {
    writeJson(input, invalid);
    assert.notEqual(quality().status, 0);
  }
  writeJson(input, checks);
  const orderSource = 'order-list.js';
  fs.writeFileSync(path.join(repo, orderSource), 'export const showOrders = true;\n');
  assert.equal(JSON.parse(quality().stdout).bddStatus, 'BLOCKED');
  const full = JSON.parse(quality('--full').stdout);
  assert.ok(full.selected.some(f => f.scenarios.some(s => s.ids.includes('OR-01'))));
  assert.equal(full.bddStatus, 'BLOCKED', 'FULL cannot stand in for mapping a second changed file');
  const mixedSource = path.join(dir, 'mixed-selection.json');
  const mixed = quality('--impact-scenario', orderSource + '=OR-01', '--run-id', plan.runId, '--output', mixedSource);
  assert.equal(mixed.status, 0, mixed.stderr);
  const mixedSelection = JSON.parse(fs.readFileSync(mixedSource));
  assert.deepEqual(mixedSelection.selected.map(f => [f.feature, f.scenarios.flatMap(s => s.ids)]), [[feature, ['OR-01']]]);
  assert.deepEqual(mixedSelection.engineeringChecks, checks);
  plan.selections = [JSON.parse(mixed.stdout)];
  plan.groups = [{ ...plan.groups[0], revision: mixedSelection.revision, scenarios: [scenario], engineeringChecks: checks }];
  writeJson(file, plan);
  template.target.dirtyPaths = [orderSource];
  writeJson(templateFile, template);
  const mixedAssignment = run('--template', templateFile);
  assert.equal(mixedAssignment.status, 0, mixedAssignment.stderr);
  const mixedGroup = JSON.parse(mixedAssignment.stdout);
  assert.deepEqual(mixedGroup.scenarios, [scenario]);
  assert.deepEqual(mixedGroup.engineeringChecks, checks);
  writeJson(input, [{ ...checks[0], path: feature }]);
  fs.appendFileSync(path.join(repo, feature), '\n');
  assert.notEqual(quality().status, 0);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-approved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'approved.json');
  const repo = path.join(dir, 'checkout');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const feature = '.bdd/modules/shop/order/list.feature';
  fs.mkdirSync(path.dirname(path.join(repo, feature)), { recursive: true });
  fs.writeFileSync(path.join(repo, feature), '@OR-01\nScenario: First\n@OR-02\nScenario: Second\n');
  git('add', '-f', '--', feature);
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const groups = ['A', 'B'].map((groupId, i) => ({
    groupId, repo, revision: { head, dirtySha256: null }, scenarios: [{
      feature, id: 'OR-0' + (i + 1), kind: 'changed',
      assertions: [{ requirement: '列表', action: '按下儲存', expected: 'A|B\n<C>', method: 'UI', evidence: '狀態截圖' }],
    }],
  }));
  const plan = { contractVersion: 3, scope: 'non-batch', runId: example.runId, groups };
  writeJson(file, plan);
  const template = structuredClone(example);
  delete template.scenarios;
  template.groupId = 'A';
  Object.assign(template.target, { repo, workDir: repo, head });
  function run(...args) {
    return spawnSync(process.execPath, [cli, 'parallel-plan', '--plan', file, ...args], { encoding: 'utf8' });
  }
  return { dir, repo, git, head, file, plan, template, run };
}

test('normal CLI emits approved assignments and report rows and prevents partial dispatch', t => {
  const { dir, file, plan, template, run } = fixture(t);
  const templateFile = path.join(dir, 'template.json');
  const files = [];
  for (const group of plan.groups) {
    writeJson(templateFile, { ...template, groupId: group.groupId });
    const output = path.join(dir, group.groupId + '.json');
    const result = run('--template', templateFile, '--output', output);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.deepEqual(actual.scenarios, group.scenarios);
    assert.deepEqual(actual.approvedPlan, {
      path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    });
    files.push(output);
  }
  const whole = run('--assignment', files[1], '--assignment', files[0]);
  assert.equal(whole.status, 0, whole.stderr || whole.stdout);
  assert.deepEqual(JSON.parse(whole.stdout).issues, []);
  const reference = JSON.parse(whole.stdout).approvedPlan;
  assert.deepEqual(reference, loadApprovedPlan(file).reference);
  const missing = run('--assignment', files[0]);
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).issues.join('\n'), /Missing approved group: B/);

  const report = run('--report');
  assert.equal(report.status, 0, report.stderr);
  assert.ok(report.stdout.startsWith('核准清單 SHA-256 `' + reference.sha256 + '`'));
  const assertionRows = report.stdout.trimEnd().split(/\r?\n/).filter(line => line.startsWith('|') && /OR-0[12]/.test(line));
  assert.equal(assertionRows.length, 2);
  assert.match(assertionRows[0], /A&#124;B<br>&#60;C&#62;/);
  for (const column of ['列表', '按下儲存', 'UI', '狀態截圖', 'OR-01']) assert.ok(assertionRows[0].includes(column));

  // The current template selects B. Redirecting it over A must preserve the earlier dispatch.
  assert.equal(run('--template', templateFile, '--output', files[0]).status, 2);
  assert.equal(JSON.parse(fs.readFileSync(files[0], 'utf8')).groupId, 'A');
  const stdout = run('--template', templateFile);
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.deepEqual(JSON.parse(stdout.stdout), JSON.parse(fs.readFileSync(files[1], 'utf8')));
  writeJson(templateFile, { ...template, scenarios: [] });
  assert.equal(run('--template', templateFile).status, 2);
  assert.equal(run('--report', '--output', files[0]).status, 2);
});

test('bound assignments reject drift in scope, owner, assertions and the reviewed plan bytes', t => {
  const { dir, file, plan, template } = fixture(t);
  const approved = loadApprovedPlan(file);
  const records = plan.groups.map(g => ({
    runId: plan.runId, groupId: g.groupId, target: template.target,
    scenarios: g.scenarios, approvedPlan: approved.reference,
  }));
  const cases = [
    [a => { a.runId = 'another-run'; }, /runId mismatch/],
    [a => { a.groupId = 'B'; }, /duplicate assignment group/],
    [a => { a.groupId = 'C'; }, /assignment group: C/],
    [a => { a.scenarios = []; }, /Missing approved scenario: A\/.*OR-01/],
    [a => { a.scenarios.push(a.scenarios[0]); }, /duplicate assigned scenario/],
    [a => { a.scenarios[0].id = 'OR-10'; }, /Unexpected or duplicate assigned scenario/],
    [a => { a.scenarios[0].kind = 'regression'; }, /kind or assertions differ/],
    [a => { a.scenarios[0].assertions[0].evidence = 'different'; }, /kind or assertions differ/],
    [a => { a.target.repo = os.tmpdir(); }, /repo mismatch/],
    [a => { delete a.approvedPlan; }, /reference mismatch/],
    [a => { a.approvedPlan.path = path.join(dir, 'other.json'); }, /reference mismatch/],
  ];
  for (const [edit, expected] of cases) {
    const actual = structuredClone(records);
    edit(actual[0]);
    assert.match(compareApprovedPlan(approved, actual).join('\n'), expected);
  }
  fs.appendFileSync(file, '\n');
  assert.match(compareApprovedPlan(loadApprovedPlan(file), records).join('\n'), /reference mismatch/);
});

test('invalid or ambiguous approved plans stop before assignments are created', t => {
  const { file, plan } = fixture(t);
  const cases = [
    [p => { p.groups = []; }, /approved plan schema/],
    [p => { delete p.groups[0].revision; }, /approved plan schema/],
    [p => { p.groups[0].revision.head = 'abcd'; }, /approved plan schema/],
    [p => { p.groups[0].revision.dirtySha256 = ''; }, /approved plan schema/],
    [p => { p.contractVersion = 1; }, /approved plan schema/],
    [p => { p.groups[0].scenarios[0].assertions[0].expected = ' '; }, /approved plan schema/],
    [p => { p.groups[1].groupId = 'a'; }, /Duplicate approved group/],
    [p => { p.groups[0].repo = './app'; }, /absolute approved repo/],
    [p => { p.groups[0].scenarios[0].feature = '../app.feature'; }, /repo-relative feature/],
    [p => { p.groups[1].scenarios = p.groups[0].scenarios; }, /Duplicate approved scenario/],
  ];
  for (const [edit, reason] of cases) {
    const bad = structuredClone(plan);
    edit(bad);
    writeJson(file, bad);
    assert.throws(() => loadApprovedPlan(file), reason);
  }
});

test('same scenario cannot be dispatched twice through linked worktrees', t => {
  const { dir, file, plan, git } = fixture(t);
  const linked = path.join(dir, 'linked checkout');
  git('worktree', 'add', '--quiet', '--detach', linked, 'HEAD');
  plan.groups[1].repo = linked;
  plan.groups[1].scenarios = plan.groups[0].scenarios;
  writeJson(file, plan);
  assert.throws(() => loadApprovedPlan(file), /Duplicate approved scenario/);
  const other = path.join(dir, 'unrelated');
  git('init', '--quiet', other);
  plan.groups[1].repo = other;
  writeJson(file, plan);
  assert.equal(loadApprovedPlan(file).groups.length, 2);
});

test('batch dispatch rejects a real but stale ID at review, template, preflight and summary', t => {
  const { dir, repo, git, file, plan, template, run } = fixture(t);
  const [prior, current] = plan.groups.map(g => g.scenarios[0]);
  const featureFile = path.join(repo, current.feature);
  fs.writeFileSync(featureFile, 'Feature: Orders\n@OR-01 @#42 @API\nScenario: First feedback\n@OR-02 @#42 @API\nScenario: Second feedback\n');
  fs.writeFileSync(path.join(path.dirname(featureFile), 'MODULE.md'), '---\nprefix: OR\npaths:\n  - receipt.txt\n---\n');
  fs.writeFileSync(path.join(repo, 'receipt.txt'), 'old amount\n');
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=bdd@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'feedback');
  git('add', '-f', '--', '.bdd', 'receipt.txt');
  commit();
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'receipt.txt'), 'correct amount\n');
  git('add', '--', 'receipt.txt');
  commit();
  template.target.head = git('rev-parse', 'HEAD');
  plan.groups[0].revision.head = template.target.head;
  const source = path.join(dir, 'quality-plan.json');
  const saved = JSON.parse(execFileSync(process.execPath, [cli, 'quality-plan', '--repo', repo, '--issue', '42',
    '--base', base, '--review-reason', 'correct amount for second feedback', '--impact-scenario', 'receipt.txt=' + current.id,
    '--static-passed', '--impact-complete', '--run-id', plan.runId, '--output', source], { encoding: 'utf8' }));
  const candidate = JSON.parse(fs.readFileSync(source, 'utf8'));
  function reference(selection) {
    writeJson(source, selection);
    return { path: source, sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') };
  }
  plan.scope = 'batch';
  plan.groups = [plan.groups[0]];
  plan.groups[0].scenarios = [current];
  plan.selections = [saved];
  writeJson(file, plan);
  const templateFile = path.join(dir, 'template.json');
  const dispatched = path.join(dir, 'assignment.json');
  writeJson(templateFile, template);
  assert.equal(run('--template', templateFile, '--output', dispatched).status, 0);
  assert.equal(run('--assignment', dispatched).status, 0);
  const changed = JSON.parse(fs.readFileSync(dispatched, 'utf8'));
  changed.scenarios[0].id = current.id.toLowerCase();
  writeJson(dispatched, changed);
  assert.equal(run('--assignment', dispatched).status, 1);
  plan.groups[0].scenarios = [prior];
  writeJson(file, plan);
  const output = path.join(dir, 'must-not-exist.json');
  for (const args of [['--report'], ['--template', templateFile, '--output', output], ['--assignment', dispatched]]) {
    const failed = run(...args);
    assert.equal(failed.status, 2);
    assert.match(failed.stderr, /Missing selected scenario: .*OR-02/);
    assert.match(failed.stderr, /Unexpected approved scenario: .*OR-01/);
  }
  assert.equal(fs.existsSync(output), false);
  assert.equal(spawnSync(process.execPath, [cli, 'parallel-summary', '--assignment', dispatched,
    '--output-dir', path.join(dir, 'summary')]).status, 2);
  plan.groups[0].scenarios = [current];
  writeJson(file, plan);
  fs.appendFileSync(source, '\n');
  assert.match(run('--report').stderr, /SHA-256 mismatch/);

  for (const [edit, error] of [
    [p => { p.runId = 'previous-round'; }, /runId/],
    [p => { p.bddStatus = 'BLOCKED'; }, /ready/],
    [p => { p.bddStatus = 'SKIPPED'; }, /ready/],
    [p => { p.revision.dirtySha256 = 'a'.repeat(64); }, /checkout and revision/],
    [p => { p.selected[0].feature = 'wrong.feature'; }, /Missing selected scenario: wrong.feature/],
  ]) {
    const changed = structuredClone(candidate);
    edit(changed);
    plan.selections = [reference(changed)];
    writeJson(file, plan);
    assert.throws(() => loadApprovedPlan(file), error);
  }
  delete plan.selections;
  writeJson(file, plan);
  assert.match(run('--report').stderr, /approved plan schema/);
});

test('one batch selection covers the union of assignments in linked worktrees at the same revision', t => {
  const { dir, repo, head, git, file, plan, run } = fixture(t);
  const linked = path.join(dir, 'linked');
  git('worktree', 'add', '--quiet', '--detach', linked, head);
  plan.groups[1].repo = linked;
  const source = path.join(dir, 'selection.json');
  const candidate = {
    runId: plan.runId, repo, base: head, head, revision: plan.groups[0].revision, issue: '42', issueScope: 'batch',
    level: 'TARGETED', staticPassed: true, bddStatus: 'PENDING',
    selected: [{ feature: plan.groups[0].scenarios[0].feature, scenarios: [{ ids: ['OR-01'] }, { ids: ['OR-02'] }] }],
  };
  writeJson(source, candidate);
  plan.scope = 'batch';
  plan.selections = [{ path: source, sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') }];
  writeJson(file, plan);
  const report = run('--report');
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /issue #42/);
  plan.groups.pop();
  writeJson(file, plan);
  assert.match(run('--report').stderr, /Missing selected scenario: .*OR-02/);
});
