import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarize } from '../scripts/lib/parallel-summary.mjs';
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
  function run(name, code, extra = [], trace) {
    const output = path.join(temp, name);
    const result = spawnSync(process.execPath, [cli, 'parallel-summary', '--output-dir', output, '--assignment', assignment, ...extra], {
      encoding: 'utf8', env: trace ? { ...process.env, GIT_TRACE2_EVENT: trace } : process.env,
    });
    assert.equal(result.status, code, result.stderr || result.stdout);
    if (code < 2) {
      const summaryPath = path.join(output, 'summary.json');
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      const expected = extra.includes('--brief') ? {
        runId: summary.runId, eligibleForReview: summary.eligibleForReview, counts: summary.counts,
        issueCount: summary.issues.length, summaryPath, ...(summary.issues.length && { firstIssue: summary.issues[0] }),
      } : summary;
      assert.deepEqual(JSON.parse(result.stdout), expected);
      return summary;
    }
    assert.equal(result.stdout, '');
    assert.ok(result.stderr);
  }
  const valid = run('valid', 0);
  assert.equal(valid.eligibleForReview, true);
  assert.deepEqual(run('valid-brief', 0, ['--brief']), valid);
  for (const file of ['summary.json', 'SUMMARY.md']) {
    assert.deepEqual(fs.readFileSync(path.join(temp, 'valid-brief', file)), fs.readFileSync(path.join(temp, 'valid', file)));
  }
  const resultPath = path.join(coord, 'result.json');
  const roundFile = path.join(group, 'verification.json');
  json(resultPath, { ...r, scenarios: [{ ...r.scenarios[0], status: 'failed' }] });
  json(roundFile, { rounds: [{ ...round, result: { ...round.result, passed: 0, failed: 1 } }] });
  const failed = run('failed-brief', 0, ['--brief']);
  assert.equal(failed.eligibleForReview, false);
  assert.equal(failed.counts.failed, 1);
  assert.deepEqual(failed.issues, []);
  json(roundFile, { rounds: [round] });
  for (const [name, overrides] of [
    ['interrupted', { taskStatus: 'interrupted' }],
    ['stale-attempt', { attempt: a.attempt + 1 }],
    ['wrong-version', { execution: { ...r.execution, serviceVersion: 'old-build' } }],
    ['invalid-status', { scenarios: [{ ...r.scenarios[0], status: 'green' }] }],
    ['duplicate-scenario', { scenarios: [...r.scenarios, r.scenarios[0]] }],
    ['outside-evidence', { scenarios: [{ ...r.scenarios[0], evidence: ['../outside.json'] }] }],
    ['missing-evidence', { scenarios: [{ ...r.scenarios[0], evidence: ['missing.json'] }] }],
  ]) {
    json(resultPath, { ...r, ...overrides });
    assert.equal(run(name, 1).eligibleForReview, false, name);
  }
  fs.unlinkSync(resultPath);
  const missing = run('missing-result', 1, ['--brief']);
  assert.equal(missing.counts['not-run'], 1);
  assert.ok(missing.issues.length > 1);
  json(resultPath, r);
  for (const [name, overrides] of [
    ['dirty-version', { dirtyPaths: ['src/login.cs'] }],
    ['missing-dirty-paths', { dirtyPaths: undefined }],
    ['wrong-count', { result: { ...round.result, passed: 2 } }],
  ]) {
    json(roundFile, { rounds: [{ ...round, ...overrides }] });
    assert.equal(run(name, 1).eligibleForReview, false, name);
  }
  const nonexistent = '1'.repeat(head.length);
  json(assignment, { ...a, target: { ...a.target, head: nonexistent } });
  json(roundFile, { rounds: [{ ...round, head: nonexistent }] });
  assert.equal(run('nonexistent-revision', 1).eligibleForReview, false);
  json(assignment, a);
  json(roundFile, { rounds: [round] });
  run('valid', 2, ['--brief']);
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
  const linked = path.join(temp, 'linked checkout 中文');
  git('worktree', 'add', '--quiet', '--detach', linked, head);
  const subdir = path.join(linked, 'nested');
  fs.mkdirSync(subdir);
  Object.assign(otherAssignment.target, { repo: subdir, workDir: linked });
  const secondRound = structuredClone(round);
  secondRound.repo.name = path.basename(linked);
  secondRound.repo.url = 'https://example.invalid/linked-only.git';
  git('config', 'extensions.worktreeConfig', 'true');
  git('-C', linked, 'config', '--worktree', 'remote.origin.url', secondRound.repo.url);
  const secondResult = structuredClone(r);
  secondResult.groupId = otherAssignment.groupId;
  secondResult.verification.path = 'linked-verification.json';
  function summarizePair(name, code, trace) {
    json(path.join(group, secondResult.verification.path), { rounds: [secondRound] });
    json(path.join(secondCoord, 'assignment.json'), otherAssignment);
    json(path.join(secondCoord, 'result.json'), secondResult);
    return run(name, code, ['--assignment', path.join(secondCoord, 'assignment.json')], trace);
  }
  const repeated = summarizePair('linked-duplicate', 1);
  assert.deepEqual(repeated.issues, ['Repeated cross-group scenario requires manual review: ' + scenario.feature + '|' + scenario.id]);
  assert.equal(repeated.counts.passed, 1);
  const secondId = 'SS-14';
  otherAssignment.scenarios[0].id = secondId;
  secondRound.scenarios[0].ids = [secondId];
  secondResult.scenarios[0].id = secondId;
  const trace = path.join(temp, 'linked-trace.ndjson');
  const independent = summarizePair('linked-distinct', 0, trace);
  assert.equal(independent.eligibleForReview, true);
  assert.equal(independent.counts.passed, 2);
  assert.deepEqual(independent.groups.map(g => g.version.repo.name), [path.basename(temp), path.basename(linked)]);
  assert.deepEqual(independent.groups.map(g => g.version.repo.url), ['', secondRound.repo.url]);
  const discovery = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.event === 'start' && event.argv.includes('--git-common-dir'));
  assert.equal(discovery.length, 2);
  assert.ok(discovery.every(event => event.argv.includes('--show-toplevel')), 'discover both paths in one Git process per checkout');
  if (process.platform !== 'win32') {
    const multiline = path.join(temp, 'linked\ncheckout');
    git('worktree', 'move', linked, multiline);
    Object.assign(otherAssignment.target, { repo: multiline, workDir: multiline });
    secondRound.repo.name = path.basename(multiline);
    assert.equal(summarizePair('linked-newline', 0).counts.passed, 2);
  }
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

test('shared checkout queries stay bounded and a concurrent remote change prevents adoption', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-summary-git-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', temp, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=bdd@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  const url = 'https://example.invalid/fixture.git';
  git('remote', 'add', 'origin', url);
  const [assignment, result] = fs.readFileSync(docs, 'utf8').split('```json').slice(1).map(e => JSON.parse(e.split('```')[0]));
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
  const files = ['A', 'B', 'C', 'D'].map((groupId, index) => {
    const outputDir = path.join(temp, groupId);
    fs.mkdirSync(outputDir);
    const id = 'SS-' + (10 + index);
    const scenario = { ...assignment.scenarios[0], id };
    const file = path.join(outputDir, 'assignment.json');
    write(file, { ...assignment, outputDir, groupId, target: { ...assignment.target, repo: temp, workDir: temp, head }, scenarios: [scenario] });
    write(path.join(outputDir, 'result.json'), { ...result, groupId,
      scenarios: [{ ...result.scenarios[0], id, evidence: ['REPORT.md#result'] }], artifacts: { report: 'REPORT.md', masking: null } });
    write(path.join(outputDir, 'verification.json'), { rounds: [{
      head, repo: { name: path.basename(temp), url }, dirtyPaths: [],
      scenarios: [{ path: scenario.feature, ids: [id], role: scenario.kind }],
      result: { passed: 1, failed: 0, blocked: 0, notRun: 0 },
    }] });
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), '## Result\nPassed');
    return file;
  });
  const destination = path.join(temp, 'summary');
  const trace = path.join(temp, 'trace.ndjson');
  const run = spawnSync(process.execPath, [cli, 'parallel-summary', '--output-dir', destination,
    ...files.flatMap(file => ['--assignment', file])], { encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).counts.passed, files.length);
  const commands = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.event === 'start').map(event => event.argv);
  const calls = arg => commands.filter(argv => argv.includes(arg)).length;
  assert.ok(calls(head + '^{commit}') <= 2, 'expected bounded commit resolution');
  assert.ok(calls('get-url') <= 2, 'expected bounded remote resolution');
  assert.ok(calls('--show-toplevel') <= 3, 'expected bounded checkout discovery');

  const independent = path.join(temp, 'independent');
  fs.mkdirSync(independent);
  git('-C', independent, 'init', '-q');
  git('-C', independent, '-c', 'user.name=Fixture', '-c', 'user.email=bdd@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'independent');
  git('-C', independent, 'remote', 'add', 'origin', url);
  const independentHead = git('-C', independent, 'rev-parse', 'HEAD');
  const independentAssignment = JSON.parse(fs.readFileSync(files[1], 'utf8'));
  Object.assign(independentAssignment.target, { repo: independent, workDir: independent, head: independentHead });
  write(files[1], independentAssignment);
  const independentRecord = path.join(temp, 'B', 'verification.json');
  const independentRound = JSON.parse(fs.readFileSync(independentRecord, 'utf8'));
  independentRound.rounds[0].repo.name = path.basename(independent);
  independentRound.rounds[0].head = independentHead;
  write(independentRecord, independentRound);

  const originalRead = fs.readFileSync;
  const lastRound = path.join(temp, 'D', 'verification.json');
  const read = t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === lastRound) git('remote', 'set-url', 'origin', url + '-moved');
    return originalRead.call(this, file, ...args);
  });
  const changed = summarize(files, destination);
  read.mock.restore();
  assert.equal(changed.eligibleForReview, false);
  assert.match(changed.issues.join('\n'), /repo changed during summary/i);
  assert.deepEqual(changed.scenarios.map(s => s.status), ['not-run', 'passed', 'not-run', 'not-run']);
  assert.deepEqual(changed.counts, { passed: 1, failed: 0, blocked: 0, 'not-run': 3 });
  const next = summarize(files, destination);
  assert.deepEqual(next.counts, changed.counts);
  assert.ok(!next.issues.some(issue => /repo changed during summary/i.test(issue)));
  assert.match(next.issues.join('\n'), /Verification repo differs/);

  git('remote', 'set-url', 'origin', url);
  const otherDir = JSON.parse(fs.readFileSync(files[2], 'utf8'));
  otherDir.target.workDir = path.join(temp, 'missing-directory');
  write(files[2], otherDir);
  const otherHead = JSON.parse(fs.readFileSync(files[3], 'utf8'));
  otherHead.target.head = '1'.repeat(head.length);
  write(files[3], otherHead);
  const otherRound = JSON.parse(fs.readFileSync(lastRound, 'utf8'));
  otherRound.rounds[0].head = otherHead.target.head;
  write(lastRound, otherRound);
  const mixed = summarize(files, destination);
  assert.deepEqual(mixed.counts, { passed: 2, failed: 0, blocked: 0, 'not-run': 2 });
  assert.ok(mixed.issues.includes('C: Assignment workDir differs from repo'));
  assert.ok(mixed.issues.includes('D: Recorded HEAD is not an existing full commit SHA'));
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
    contractVersion: 3, scope: 'non-batch', runId: 'approved-run',
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

test('summary batches historical Features across groups and isolates a missing path or ID', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-summary-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'checkout');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const features = ['one.feature', '中文 two.feature', 'three.feature', 'absent.feature'];
  const ids = ['AA-01', 'AA-02', 'AA-03', 'AA-04'];
  for (const [i, feature] of features.slice(0, 3).entries()) {
    fs.writeFileSync(path.join(repo, feature), '@' + ids[i] + '\nScenario: At the tested revision\n');
  }
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'features');
  const head = git('rev-parse', 'HEAD');
  // The working tree has the missing ID/path. Only committed contents may satisfy this plan.
  fs.writeFileSync(path.join(repo, features[2]), '@AA-99\nScenario: New ID');
  fs.writeFileSync(path.join(repo, features[3]), '@AA-04\nScenario: New file');
  const [template, result] = fs.readFileSync(docs, 'utf8').split('```json').slice(1, 3).map(s => JSON.parse(s.split('```')[0]));
  const revision = { head, dirtySha256: null };
  const groups = features.map((feature, i) => ({
    groupId: 'team-' + i, revision, repo, scenarios: [{ feature, id: i === 2 ? 'AA-99' : ids[i], kind: 'changed',
      assertions: [{ requirement: 'Read', action: 'Read list', expected: 'Item', method: 'API', evidence: 'Report' }] }],
  }));
  const plan = { contractVersion: 3, scope: 'non-batch', runId: template.runId, groups };
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
  const planFile = path.join(root, 'approved.json');
  write(planFile, plan);
  const sha256 = createHash('sha256').update(fs.readFileSync(planFile)).digest('hex');
  const files = groups.map(({ groupId, scenarios }) => {
    const [{ feature, id, kind }] = scenarios;
    const dir = path.join(root, groupId);
    fs.mkdirSync(dir);
    const file = path.join(dir, 'assignment.json');
    write(file, { ...template, groupId, outputDir: dir, target: { ...template.target, repo, workDir: repo, head },
      scenarios, approvedPlan: { path: planFile, sha256 } });
    write(path.join(dir, 'result.json'), { ...result, groupId, approvedPlanSha256: sha256,
      scenarios: [{ ...result.scenarios[0], feature, id, kind, evidence: ['REPORT.md'] }], artifacts: { report: 'REPORT.md', masking: null } });
    write(path.join(dir, 'verification.json'), { rounds: [{ revision, head, repo: { name: 'checkout', url: '' }, dirtyPaths: [],
      scenarios: [{ path: feature, ids: [id], role: kind }], result: { passed: 1, failed: 0, blocked: 0, notRun: 0 } }] });
    fs.writeFileSync(path.join(dir, 'REPORT.md'), 'Checked list');
    return file;
  });
  const trace = path.join(root, 'trace');
  const run = spawnSync(process.execPath, [cli, 'parallel-summary', '--output-dir', path.join(root, 'out'),
    ...files.flatMap(f => ['--assignment', f])], { encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace } });
  assert.equal(run.status, 1, run.stderr || run.stdout);
  const summary = JSON.parse(run.stdout);
  assert.deepEqual(summary.scenarios.map(s => s.status), ['passed', 'passed', 'not-run', 'not-run']);
  assert.ok(summary.issues.some(issue => issue.includes('AA-99')));
  assert.ok(summary.issues.some(issue => issue.includes('absent.feature')));
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.event === 'start' && event.argv.includes('cat-file'));
  assert.equal(calls.filter(event => event.argv.includes('--batch')).length, 1);
  assert.ok(calls.length <= 2, 'valid paths should share a single Git content query');

  fs.unlinkSync(path.join(root, 'team-1', 'result.json'));
  const staleFile = path.join(root, 'team-2', 'verification.json');
  const stale = JSON.parse(fs.readFileSync(staleFile));
  stale.rounds[0].repo.name = 'other-checkout';
  write(staleFile, stale);
  const blockedFile = path.join(root, 'team-3', 'result.json');
  const blocked = JSON.parse(fs.readFileSync(blockedFile));
  blocked.taskStatus = 'blocked';
  blocked.verification = null;
  blocked.blockers = [{ reason: 'no account', scenarioIds: [ids[3]], resolution: null }];
  Object.assign(blocked.scenarios[0], { status: 'blocked', reason: 'no account', evidence: [] });
  write(blockedFile, blocked);
  const partialTrace = path.join(root, 'partial-trace');
  const partial = spawnSync(process.execPath, [cli, 'parallel-summary', '--output-dir', path.join(root, 'partial'),
    ...files.flatMap(f => ['--assignment', f])], { encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: partialTrace } });
  assert.equal(partial.status, 1, partial.stderr);
  const detail = JSON.parse(partial.stdout);
  assert.deepEqual(detail.scenarios.map(s => s.status), ['passed', 'not-run', 'not-run', 'blocked']);
  assert.deepEqual(detail.issues.map(s => s.split(':')[0]), ['team-1', 'Missing or unacceptable scenario result',
    'team-2', 'Missing or unacceptable scenario result', 'team-3', 'team-3']);
  const reads = fs.readFileSync(partialTrace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.event === 'start' && event.argv.includes('cat-file')).map(event => event.argv);
  assert.equal(reads.length, 1);
  assert.ok(reads[0].includes(head + ':' + features[0]), 'only the completed, version-matched submission needs a historical Feature');

  stale.rounds[0].repo.name = 'checkout';
  write(staleFile, stale);
  const invalidFile = path.join(root, 'team-2', 'result.json');
  const invalid = JSON.parse(fs.readFileSync(invalidFile));
  const proof = path.join(root, 'team-2', 'proof.md');
  fs.writeFileSync(proof, '## Observation\nActual evidence');
  invalid.scenarios[0].evidence = ['proof.md#observation', 'missing-evidence.txt'];
  write(invalidFile, invalid);
  let evidenceReads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === proof) evidenceReads++;
    return read.call(this, file, ...args);
  });
  const mixed = summarize(files, path.join(root, 'mixed'));
  assert.match(mixed.issues.find(message => message.startsWith('team-2:')), /找不到指定編號：AA-99/);
  assert.equal(evidenceReads, 0, 'a missing historical ID must stop the group before evidence contents are read');
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

test('report-only evidence requires section contents and collects referenced local attachments', async () => {
  const { reportEvidence } = await import('../scripts/lib/report-anchors.mjs');
  const { populated, attachments } = reportEvidence([
    '# Run', '## Empty', '<!-- nothing yet -->', '## SS-1', '### Response',
    '```json', '{"count": 3, "example": "![x](ignore.png)"}', '```',
    '## SS-1', '----', '<a id="scenario-2"></a>', 'Observed count', '--------------',
    'The list returned three rows. `![sample](ignore.svg)`',
    '[trace](evidence/%E6%B8%AC%E8%A9%A6.json#section)', '![view][screen]', '<img src="output.png">',
    '[screen]: <./evidence/Result page.png> "result"', '[unused]: evidence/unused.png',
    '[online](https://example.org/evidence/external.json)', '<!-- ![x](comment.png) -->',
    '[API response](trace.json)', '![截圖 [詳情]](evidence/details.png)',
    '## Last', '| --- | :---: |', '<填寫該情境的實際操作與觀察結果。>',
  ].join('\n'));
  assert.deepEqual([...populated].sort(), ['run', 'ss-1', 'response', 'scenario-2', 'observed-count'].sort());
  assert.deepEqual([...attachments].sort(), ['evidence/測試.json', 'evidence/Result page.png', 'evidence/details.png', 'output.png', 'trace.json'].sort());
  assert.throws(() => reportEvidence('## IC-01\n![screen](data:image/png;base64,AA==)'), /遮罩/);
});
