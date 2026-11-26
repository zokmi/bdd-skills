import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const guide = fs.readFileSync(new URL('../references/parallel-bdd-contract.md', import.meta.url), 'utf8');
const examples = Array.from(guide.matchAll(/^`{3}json\r?\n([\s\S]+?)\r?\n`{3}/gm), match => JSON.parse(match[1]));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function invokeFrom(cwd, expected, ...args) {
  const proc = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  assert.equal(proc.status, expected, args.join(' ') + '\n' + proc.stderr + proc.stdout);
  return expected === 2 ? proc.stderr : proc.stdout;
}
const invoke = (expected, ...args) => invokeFrom(undefined, expected, ...args);

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-plan-revision-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'product');
  const workDir = path.join(repo, 'src');
  const source = path.join(workDir, 'amount.txt');
  const outputDir = path.join(temp, 'group');
  const coord = path.join(outputDir, 'coordination', 'attempt-1');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(coord, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trimEnd();
  const commit = () => {
    git('add', '--', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=bdd@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'change');
  };
  const [a, r] = structuredClone(examples);
  const feature = a.scenarios[0].feature;
  fs.mkdirSync(path.dirname(path.join(repo, feature)), { recursive: true });
  fs.writeFileSync(path.join(repo, feature), '@' + a.scenarios[0].id + '\nScenario: Read amount\n');
  fs.writeFileSync(source, 'original\n');
  git('init', '-q');
  git('add', '-f', '--', feature);
  commit();
  const revision = () => JSON.parse(invoke(0, 'parallel-plan', '--revision', repo));
  const group = {
    groupId: a.groupId, repo, revision: revision(), scenarios: a.scenarios.map(s => ({
      ...s, assertions: [{ requirement: 'Correct amount', action: 'Read amount', expected: 'Matches input', method: 'API', evidence: 'Response' }],
    })),
  };
  assert.deepEqual(group.revision, { head: git('rev-parse', 'HEAD'), dirtySha256: null });
  const plan = { contractVersion: 2, runId: a.runId, groups: [group] };
  const planFile = path.join(temp, 'plan.json');
  const templateFile = path.join(temp, 'template.json');
  const assignedFile = path.join(coord, 'assignment.json');
  const template = { ...a, outputDir, resources: [], target: { ...a.target, repo, workDir, head: group.revision.head, dirtyPaths: [] } };
  delete template.scenarios;
  delete template.approvedPlan;
  save(templateFile, template);
  save(planFile, plan);
  const usePlan = (code, ...args) => invoke(code, 'parallel-plan', '--plan', planFile, ...args);
  const summarize = (code, dir) => JSON.parse(invoke(code, 'parallel-summary', '--assignment', assignedFile, '--output-dir', path.join(temp, dir)));
  function record(assignment, capture = true) {
    save(assignedFile, assignment);
    const round = JSON.parse(invokeFrom(repo, 0, 'verification', '--record', '--dir', outputDir,
      '--head', assignment.target.head, '--commits', assignment.target.head, '--changed-scenarios', feature,
      '--passed', '1', ...(capture ? ['--capture-revision'] : [])));
    const { rounds } = JSON.parse(fs.readFileSync(path.join(outputDir, 'verification.json'), 'utf8'));
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), 'Result observed\n');
    save(path.join(coord, 'result.json'), { ...r, approvedPlanSha256: assignment.approvedPlan.sha256,
      verification: { path: 'verification.json', roundIndex: rounds.length - 1 },
      artifacts: { report: 'REPORT.md', masking: null }, resourceStates: [],
      scenarios: r.scenarios.map(s => ({ ...s, evidence: ['REPORT.md'] })),
    });
    return round;
  }
  return { temp, repo, source, git, commit, revision, group, plan, planFile, template, templateFile, assignedFile, record, usePlan, summarize };
}

test('live dispatch binds the reviewed checkout, historical summary uses the recorded candidate', t => {
  const f = fixture(t);
  assert.ok(f.usePlan(0, '--report').includes(f.group.revision.head));
  const assigned = JSON.parse(f.usePlan(0, '--template', f.templateFile));
  f.record(assigned, false);
  const missingSnapshot = f.summarize(1, 'missing-recorded-snapshot');
  assert.equal(missingSnapshot.counts['not-run'], 1);
  assert.match(missingSnapshot.issues.join('\n'), /revision/i);
  assert.deepEqual(JSON.parse(f.usePlan(0, '--assignment', f.assignedFile)).issues, []);
  const untracked = path.join(f.repo, 'untracked-service.js');
  fs.writeFileSync(untracked, 'changed after dispatch\n');
  const dirtyRound = f.record(assigned);
  assert.deepEqual(dirtyRound.dirtyPaths, []);
  assert.notEqual(dirtyRound.revision.dirtySha256, f.group.revision.dirtySha256);
  assert.equal(f.summarize(1, 'unreviewed-working-changes').counts['not-run'], 1);
  fs.unlinkSync(untracked);
  f.record(assigned);
  const other = path.join(f.temp, 'other-worktree');
  f.git('worktree', 'add', '--detach', '-q', other, f.group.revision.head);
  save(f.templateFile, { ...f.template, target: { ...f.template.target, workDir: other } });
  assert.match(f.usePlan(2, '--template', f.templateFile), /workDir/);
  save(f.templateFile, f.template);

  fs.writeFileSync(path.join(f.repo, f.group.scenarios[0].feature), '@SS-21\nScenario: replacement\n');
  fs.writeFileSync(f.source, 'committed change\n');
  f.commit();
  const head = f.git('rev-parse', 'HEAD');
  assert.match(f.usePlan(2, '--report'), /revision/i);
  assert.match(f.usePlan(2, '--template', f.templateFile), /revision/i);
  assert.match(f.usePlan(1, '--assignment', f.assignedFile), /revision/i);
  assert.equal(f.summarize(0, 'historical').eligibleForReview, true);
  f.record({ ...assigned, target: { ...assigned.target, head } });
  const changedSubmission = f.summarize(1, 'unreviewed-head');
  assert.equal(changedSubmission.eligibleForReview, false);
  assert.equal(changedSubmission.counts['not-run'], 1);
});

test('old v2 records cannot turn an ID absent at the recorded commit into passing evidence', t => {
  const f = fixture(t);
  const a = JSON.parse(f.usePlan(0, '--template', f.templateFile));
  f.record(a);
  // Older recorders trusted the explicit ID in <feature>::<ID>.
  f.group.scenarios[0].id = 'SS-99';
  save(f.planFile, f.plan);
  a.scenarios = f.group.scenarios;
  a.approvedPlan.sha256 = createHash('sha256').update(fs.readFileSync(f.planFile)).digest('hex');
  save(f.assignedFile, a);
  const verification = path.join(f.template.outputDir, 'verification.json');
  const doc = JSON.parse(fs.readFileSync(verification));
  doc.rounds[0].scenarios[0].ids = ['SS-99'];
  save(verification, doc);
  const resultPath = path.join(path.dirname(f.assignedFile), 'result.json');
  const result = JSON.parse(fs.readFileSync(resultPath));
  result.scenarios[0].id = 'SS-99';
  result.approvedPlanSha256 = a.approvedPlan.sha256;
  save(resultPath, result);
  fs.writeFileSync(path.join(f.repo, a.scenarios[0].feature), '@SS-99\nScenario: added later\n');
  f.commit();
  const summary = f.summarize(1, 'stale-scenario');
  assert.equal(summary.counts['not-run'], 1);
  assert.match(summary.issues.join('\n'), /SS-99/);
});

test('dirty candidate dispatch rejects changes of content even with the same HEAD and dirty path list', t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, 'reviewed dirty contents\n');
  f.group.revision = f.revision();
  assert.match(f.group.revision.dirtySha256, /^[a-f0-9]{64}$/);
  save(f.planFile, f.plan);
  assert.ok(f.usePlan(0, '--report').includes(f.group.revision.dirtySha256));
  assert.match(f.usePlan(2, '--template', f.templateFile), /dirty|revision/i);
  f.template.target.dirtyPaths = ['src/amount.txt'];
  save(f.templateFile, f.template);
  const assigned = JSON.parse(f.usePlan(0, '--template', f.templateFile));
  save(f.assignedFile, assigned);
  assert.deepEqual(JSON.parse(f.usePlan(0, '--assignment', f.assignedFile)).issues, []);
  fs.writeFileSync(f.source, 'other dirty contents\n');
  assert.match(f.usePlan(2, '--template', f.templateFile), /revision/i);
  assert.match(f.usePlan(1, '--assignment', f.assignedFile), /revision/i);
});

test('plan and recording reject scenario IDs absent from the tested feature', t => {
  const f = fixture(t);
  const scenario = f.group.scenarios[0];
  const { head } = f.group.revision;
  const assigned = JSON.parse(f.usePlan(0, '--template', f.templateFile));
  scenario.id = 'SS-99';
  save(f.planFile, f.plan);
  assert.match(f.usePlan(2, '--report'), /SS-99/);
  assert.match(f.usePlan(2, '--template', f.templateFile), /SS-99/);
  save(f.assignedFile, assigned);
  assert.match(f.usePlan(1, '--assignment', f.assignedFile), /SS-99/);
  const recordArgs = ['verification', '--record', '--dir', f.template.outputDir, '--commits', head, '--regression-scenarios'];
  assert.match(invokeFrom(f.repo, 2, ...recordArgs, scenario.feature + '::SS-99'), /SS-99/);
  assert.equal(fs.existsSync(path.join(f.template.outputDir, 'verification.json')), false);
  const file = path.join(f.repo, scenario.feature);
  fs.writeFileSync(file, '@SS-99\nDémonstration: legacy title\n@SS-77\nNotes: instructions\n@SS-78\nGiven data: one item\n@SS-79\n');
  f.commit();
  assert.match(invokeFrom(f.repo, 2, ...recordArgs, scenario.feature + '::SS-99', '--head', head), /SS-99/);
  assert.deepEqual(JSON.parse(invokeFrom(f.repo, 0, ...recordArgs, scenario.feature + '::SS-13', '--head', head)).scenarios[0].ids, ['SS-13']);
  f.group.revision = f.revision();
  save(f.planFile, f.plan);
  assert.match(f.usePlan(0, '--report'), /SS-99/);
  assert.deepEqual(JSON.parse(invokeFrom(f.repo, 0, ...recordArgs, scenario.feature + '::SS-99')).scenarios[0].ids, ['SS-99']);
  assert.deepEqual(JSON.parse(invokeFrom(f.repo, 0, ...recordArgs, scenario.feature)).scenarios[0].ids, ['SS-99']);
  for (const id of ['SS-77', 'SS-78', 'SS-79']) {
    assert.match(invokeFrom(f.repo, 2, ...recordArgs, scenario.feature + '::' + id), new RegExp(id));
    scenario.id = id;
    save(f.planFile, f.plan);
    assert.match(f.usePlan(2, '--report'), new RegExp(id));
  }
});

test('dispatch and summary use the physical checkout when directory names differ only in case', t => {
  const f = fixture(t);
  const other = path.join(f.temp, 'Product');
  const assigned = JSON.parse(f.usePlan(0, '--template', f.templateFile));
  const target = { ...assigned.target, workDir: other };
  save(f.templateFile, { ...f.template, target });
  if (fs.existsSync(other)) {
    // Both spellings resolve to the same existing directory on this filesystem.
    f.record(JSON.parse(f.usePlan(0, '--template', f.templateFile)));
    assert.equal(f.summarize(0, 'case-alias').eligibleForReview, true);
    return;
  }
  fs.cpSync(f.repo, other, { recursive: true });
  assert.match(f.usePlan(2, '--template', f.templateFile), /workDir/);
  f.record({ ...assigned, target });
  assert.match(f.summarize(1, 'other-checkout').issues.join('\n'), /workDir/);

  f.plan.groups.push({ ...f.group, groupId: 'other', repo: other });
  save(f.planFile, f.plan);
  fs.writeFileSync(path.join(other, 'changed.txt'), 'changed after review');
  assert.match(f.usePlan(2, '--report'), /Candidate revision changed for group other/);
});

test('v1 plan records remain readable and fresh dispatch requires a candidate-bound plan', t => {
  const f = fixture(t);
  f.plan.contractVersion = 1;
  delete f.group.revision;
  save(f.planFile, f.plan);
  const sha256 = createHash('sha256').update(fs.readFileSync(f.planFile)).digest('hex');
  f.record({ ...f.template, scenarios: f.group.scenarios, approvedPlan: { path: f.planFile, sha256 } }, false);
  for (const args of [['--template', f.templateFile], ['--report'], ['--assignment', f.assignedFile]]) {
    assert.match(f.usePlan(2, ...args), /v1.*revision/i);
  }
  const summary = f.summarize(0, 'legacy');
  assert.equal(summary.eligibleForReview, true);
  assert.match(summary.limitation, /v1.*candidate/i);
  assert.match(fs.readFileSync(path.join(f.temp, 'legacy', 'SUMMARY.md'), 'utf8'), /v1.*candidate/i);
});
