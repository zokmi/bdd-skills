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

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-approved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'approved.json');
  const groups = ['A', 'B'].map((groupId, i) => ({
    groupId, repo: dir, scenarios: [{
      feature: '.bdd/modules/shop/order/list.feature', id: 'OR-0' + (i + 1), kind: 'changed',
      assertions: [{ requirement: '列表', action: '按下儲存', expected: 'A|B\n<C>', method: 'UI', evidence: '狀態截圖' }],
    }],
  }));
  const plan = { contractVersion: 1, runId: example.runId, groups };
  writeJson(file, plan);
  const template = structuredClone(example);
  delete template.scenarios;
  template.groupId = 'A';
  Object.assign(template.target, { repo: dir, workDir: dir });
  function run(...args) {
    return spawnSync(process.execPath, [cli, 'parallel-plan', '--plan', file, ...args], { encoding: 'utf8' });
  }
  return { dir, file, plan, template, run };
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
  const rows = report.stdout.trimEnd().split(/\r?\n/).filter(line => line.startsWith('|'));
  assert.equal(rows.length, 4);
  assert.match(rows[2], /A&#124;B<br>&#60;C&#62;/);
  for (const column of ['列表', '按下儲存', 'UI', '狀態截圖', 'OR-01']) assert.ok(rows[2].includes(column));

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
  const { dir, file, plan } = fixture(t);
  const approved = loadApprovedPlan(file);
  const records = plan.groups.map(g => ({
    runId: plan.runId, groupId: g.groupId, target: { repo: dir },
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
  const { dir, file, plan } = fixture(t);
  function git(...args) {
    return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  }
  git('init', '--quiet');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '-m', 'fixture');
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
