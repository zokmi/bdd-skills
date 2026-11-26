import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkModifiedPaths, checkSeparateDirectories, evidenceChecker } from '../scripts/lib/summary-evidence.mjs';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const docs = new URL('../references/parallel-bdd-contract.md', import.meta.url);

test('parallel summary checks masking hashes and verification rounds, deduplicates checkouts and preserves blockers', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-summary-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const group = path.join(temp, 'group');
  const evidence = path.join(group, 'evidence');
  const coord = path.join(group, 'coordination/attempt-1');
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(coord, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', temp, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=bdd@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const examples = fs.readFileSync(docs, 'utf8').split('```json').slice(1).map(e => JSON.parse(e.split('```')[0]));
  const [a, r] = examples;
  a.outputDir = group;
  Object.assign(a.target, { repo: temp, workDir: temp, head });
  const scenario = a.scenarios[0];
  const round = {
    repo: { name: path.basename(temp), url: '' }, head, dirtyPaths: [],
    scenarios: [{ path: scenario.feature, ids: [scenario.id], role: scenario.kind }],
    result: { passed: 1, failed: 0, blocked: 0, notRun: 0 },
  };
  const json = (file, data) => fs.writeFileSync(file, '\uFEFF' + JSON.stringify(data));
  const assignment = path.join(coord, 'assignment.json');
  json(assignment, a);
  json(path.join(group, 'verification.json'), { rounds: [round] });
  const image = 'evidence/圖片.png';
  r.scenarios[0].evidence = [image + '#step'];
  json(path.join(coord, 'result.json'), r);
  fs.writeFileSync(path.join(evidence, '圖片.png'), 'fixture');
  fs.writeFileSync(path.join(group, 'REPORT.md'), 'report');
  const ledger = path.join(group, 'masking.json');
  json(ledger, { files: { [image]: { method: 'css', sha256: createHash('sha256').update('fixture').digest('hex').toUpperCase() } } });
  function run(name, code, extra = []) {
    const output = path.join(temp, name);
    const result = spawnSync(process.execPath, [cli, 'parallel-summary', '--output-dir', output, '--assignment', assignment, ...extra], { encoding: 'utf8' });
    assert.equal(result.status, code, result.stderr || result.stdout);
    if (code < 2) {
      const summary = JSON.parse(result.stdout);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8')), summary);
      return summary;
    }
  }
  assert.equal(run('valid', 0).eligibleForReview, true);
  run('valid', 2);
  assert.equal(run('duplicate', 1, ['--assignment', assignment]).counts.passed, 1);
  const secondCoord = path.join(group, 'coordination/second');
  fs.mkdirSync(secondCoord);
  const otherAssignment = structuredClone(a);
  otherAssignment.groupId = 'other-team';
  otherAssignment.target.repo = group;
  json(path.join(secondCoord, 'assignment.json'), otherAssignment);
  json(path.join(secondCoord, 'result.json'), { ...r, groupId: 'other-team' });
  const aliased = run('shared-checkout', 1, ['--assignment', path.join(secondCoord, 'assignment.json')]);
  assert.equal(aliased.counts.passed, 1);
  assert.match(aliased.issues.join('\n'), /Repeated cross-group/);
  const linked = path.join(temp, 'linked-checkout');
  git('worktree', 'add', '--quiet', '--detach', linked, head);
  Object.assign(otherAssignment.target, { repo: linked, workDir: linked });
  const secondRound = structuredClone(round);
  secondRound.repo.name = path.basename(linked);
  const secondResult = structuredClone(r);
  secondResult.groupId = otherAssignment.groupId;
  secondResult.verification.path = 'linked-verification.json';
  function summarizePair(name, code) {
    json(path.join(group, secondResult.verification.path), { rounds: [secondRound] });
    json(path.join(secondCoord, 'assignment.json'), otherAssignment);
    json(path.join(secondCoord, 'result.json'), secondResult);
    return run(name, code, ['--assignment', path.join(secondCoord, 'assignment.json')]);
  }
  const repeated = summarizePair('linked-duplicate', 1);
  assert.deepEqual(repeated.issues, ['Repeated cross-group scenario requires manual review: ' + scenario.feature + '|' + scenario.id]);
  assert.equal(repeated.counts.passed, 1);
  const secondId = 'SS-14';
  otherAssignment.scenarios[0].id = secondId;
  secondRound.scenarios[0].ids = [secondId];
  secondResult.scenarios[0].id = secondId;
  const independent = summarizePair('linked-distinct', 0);
  assert.equal(independent.eligibleForReview, true);
  assert.equal(independent.counts.passed, 2);
  assert.deepEqual(independent.groups.map(g => g.version.repo.name), [path.basename(temp), path.basename(linked)]);
  const verificationPath = path.join(group, 'verification.json');
  json(verificationPath, { rounds: { 0: round } });
  assert.equal(run('invalid-rounds', 1).counts['not-run'], 1);
  round.scenarios[0].blob = null;
  json(verificationPath, { rounds: [round] });
  assert.equal(run('uncommitted-scenario', 1).counts['not-run'], 1);
  delete round.scenarios[0].blob;
  if (process.platform !== 'win32') {
    round.scenarios[0].path = scenario.feature.toUpperCase();
    json(verificationPath, { rounds: [round] });
    assert.equal(run('case-mismatch', 1).counts['not-run'], 1);
    round.scenarios[0].path = scenario.feature;
  }
  json(verificationPath, { rounds: [round] });
  fs.appendFileSync(path.join(evidence, '圖片.png'), 'changed');
  const stale = run('stale', 1);
  assert.equal(stale.counts['not-run'], 1);
  assert.match(stale.issues.join('\n'), /Invalid image masking/);
  run('group/summary', 2);
  assert.ok(!fs.existsSync(path.join(group, 'summary')));
  r.taskStatus = 'blocked';
  r.blockers = [{ reason: 'Missing account', scenarioIds: [scenario.id], resolution: null }];
  r.verification = null;
  Object.assign(r.scenarios[0], { status: 'blocked', reason: 'Missing account', evidence: [] });
  json(path.join(coord, 'result.json'), r);
  assert.equal(run('blocked', 1).counts.blocked, 1);
});

test('summary destination cannot alias group output through a directory link', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-summary-link-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const group = path.join(temp, 'group');
  const link = path.join(temp, 'link');
  fs.mkdirSync(group);
  try { fs.symlinkSync(group, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error.code === 'EPERM') return t.skip('Environment cannot create directory links');
    throw error;
  }
  assert.throws(() => checkSeparateDirectories(group, path.join(link, 'nested', 'summary')), /separate from group/);
});

test('approved assignments account for the entire plan even when the caller omits a group', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-approved-summary-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'checkout');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'list.feature'), '@AA-01\nScenario: First\n@BB-01\nScenario: Second\n');
  git('add', 'list.feature');
  git('-c', 'user.name=Fixture', '-c', 'user.email=bdd@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const [baseAssignment, baseResult] = fs.readFileSync(docs, 'utf8').split('```json').slice(1).map(e => JSON.parse(e.split('```')[0]));
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const planFile = path.join(temp, 'approved.json');
  const plan = {
    contractVersion: 2, runId: 'approved-run',
    groups: ['A', 'B'].map(groupId => ({
      groupId, repo, revision: { head, dirtySha256: null }, scenarios: [{
        feature: 'list.feature', id: groupId.repeat(2) + '-01', kind: 'changed',
        assertions: [{ requirement: 'List items', action: 'Load the list', expected: 'One item', method: 'API', evidence: 'Response body' }],
      }],
    })),
  };
  write(planFile, plan);
  function command(expected, ...args) {
    const cliResult = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(cliResult.status, expected, cliResult.stderr || cliResult.stdout);
    return JSON.parse(cliResult.stdout);
  }
  const files = plan.groups.map(group => {
    const outputDir = path.join(temp, group.groupId);
    const coord = path.join(outputDir, 'coordination', 'attempt-1');
    fs.mkdirSync(coord, { recursive: true });
    const template = { ...baseAssignment, runId: plan.runId, groupId: group.groupId, outputDir,
      target: { ...baseAssignment.target, repo, workDir: repo, head }, resources: [] };
    delete template.scenarios;
    const templateFile = path.join(coord, 'template.json');
    write(templateFile, template);
    const assignment = command(0, 'parallel-plan', '--plan', planFile, '--template', templateFile);
    const file = path.join(coord, 'assignment.json');
    write(file, assignment);
    const [{ feature, id, kind }] = assignment.scenarios;
    write(path.join(coord, 'result.json'), { ...baseResult, runId: plan.runId, groupId: group.groupId, approvedPlanSha256: assignment.approvedPlan.sha256,
      scenarios: [{ ...baseResult.scenarios[0], feature, id, kind, evidence: ['REPORT.md#result'] }],
      artifacts: { report: 'REPORT.md', masking: null }, resourceStates: [] });
    write(path.join(outputDir, 'verification.json'), { rounds: [{
      repo: { name: path.basename(repo), url: '' }, head, dirtyPaths: [], revision: group.revision,
      scenarios: [{ path: feature, ids: [id], role: kind }], result: { passed: 1, failed: 0, blocked: 0, notRun: 0 },
    }] });
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), '## Result\nOne item');
    return file;
  });
  function summary(name, code, inputs, ...options) {
    return command(code, 'parallel-summary', '--output-dir', path.join(temp, name),
      ...inputs.flatMap(file => ['--assignment', file]), ...options);
  }
  const complete = summary('both', 0, files);
  assert.equal(complete.eligibleForReview, true);
  assert.equal(complete.counts.passed, 2);
  assert.equal(complete.approvedPlan.sha256, createHash('sha256').update(fs.readFileSync(planFile)).digest('hex'));
  for (const [mode, options] of [['implicit', []], ['explicit', ['--plan', planFile]]]) {
    const incomplete = summary(mode, 1, [files[0]], ...options);
    assert.equal(incomplete.eligibleForReview, false);
    assert.deepEqual(incomplete.counts, { passed: 1, failed: 0, blocked: 0, 'not-run': 1 });
    assert.match(incomplete.issues.join('\n'), /\bB\b/);
    assert.deepEqual(incomplete.scenarios.map(s => [s.groupId, s.id, s.status]), [['A', 'AA-01', 'passed'], ['B', 'BB-01', 'not-run']]);
  }
  assert.equal(summary('none', 1, [], '--plan', planFile).counts['not-run'], 2);

  const original = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  const extraDir = path.join(temp, 'A', 'coordination', 'extra');
  fs.mkdirSync(extraDir);
  const extra = path.join(extraDir, 'assignment.json');
  for (const [name, variant, passed] of [
    ['unexpected', { groupId: 'X' }, 2],
    ['duplicate-attempt', { attempt: 2 }, 1],
  ]) {
    write(extra, { ...original, ...variant });
    for (const [order, inputs] of [['first', [extra, ...files]], ['last', [...files, extra]]]) {
      const conflict = summary(name + '-' + order, 1, inputs);
      assert.equal(conflict.eligibleForReview, false);
      assert.equal(conflict.counts.passed, passed);
      assert.equal(conflict.counts['not-run'], 2 - passed);
    }
  }
  const liveScope = original.scenarios[0];
  for (const [name, changedScope] of [
    ['different-kind', { ...liveScope, kind: 'regression' }],
    ['different-assertions', { ...liveScope, assertions: [{ ...liveScope.assertions[0], expected: 'Two items' }] }],
  ]) {
    write(files[0], { ...original, scenarios: [changedScope] });
    const mismatch = summary(name, 1, files);
    assert.equal(mismatch.eligibleForReview, false);
    assert.deepEqual(mismatch.scenarios.map(s => s.status), ['not-run', 'passed']);
  }
  const legacy = structuredClone(original);
  delete legacy.approvedPlan;
  delete legacy.scenarios[0].assertions;
  write(files[0], legacy);
  const mixed = summary('mixed', 1, files);
  assert.equal(mixed.eligibleForReview, false);
  assert.equal(mixed.counts['not-run'], 1);

  write(files[0], original);
  fs.appendFileSync(planFile, '\n');
  const changed = summary('changed-plan', 1, files);
  assert.equal(changed.eligibleForReview, false);
  assert.equal(changed.counts['not-run'], 2);
  plan.groups[0].scenarios[0].assertions[0].expected = 'Two items';
  write(planFile, plan);
  for (const file of files) {
    const template = path.join(path.dirname(file), 'template.json');
    write(file, command(0, 'parallel-plan', '--plan', planFile, '--template', template));
  }
  const stale = summary('old-results', 1, files);
  assert.equal(stale.eligibleForReview, false);
  assert.equal(stale.counts['not-run'], 2);
  assert.match(stale.issues.join('\n'), /Result approved plan digest/);
});

test('editable paths retain PowerShell string wildcard and literal rules', () => {
  checkModifiedPaths(['src/a/b.js', 'file3.txt', 'f*.js'], ['src/*.js', 'file[0-9].txt', 'f\x60*.js']);
  assert.throws(() => checkModifiedPaths(['filex.txt'], ['file[0-9].txt']), /Unauthorized/);
  assert.throws(() => checkModifiedPaths(['src/../outside'], ['*']), /Unsafe/);
});

test('Markdown evidence fragments must identify a report heading or explicit anchor', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-report-sections-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'REPORT.md'), [
    '# SS-13', '## **訂單** [明細](list)', '## 訂單 明細', '### SS-13',
    '補充佐證', '--------', '<a name="Stable-ID"></a>', '<span id="another"></span>',
    '```md', '## sample', '<a id="example">', '```', '<!-- <a id="hidden"> -->',
  ].join('\n'));
  const check = evidenceChecker(root);
  for (const fragment of ['ss-13', 'ss-13-1', '訂單-明細', encodeURIComponent('訂單-明細-1'), '補充佐證', 'Stable-ID', 'another']) {
    check('REPORT.md#' + fragment, true);
  }
  check('REPORT.md', true);
  for (const fragment of ['missing', 'sample', 'example', 'hidden', 'ss-13-2']) {
    assert.throws(() => check('REPORT.md#' + fragment, true), /REPORT\.md#/);
  }
});
