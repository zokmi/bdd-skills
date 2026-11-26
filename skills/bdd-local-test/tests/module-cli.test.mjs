import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { moduleIndex, nextId } from '../scripts/lib/module-index.mjs';
import { lint } from '../scripts/lib/module-lint.mjs';
import { buildQualityPlan } from '../scripts/lib/quality-plan.mjs';

test('successive feedback commits select their own cases and reviewed dependencies', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-feedback-plan-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8' }));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  const commit = message => {
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const plan = (base, ...args) => run('quality-plan', '--base', base, '--review-reason', 'Reviewed the feedback and its callers',
    '--impact-complete', '--static-passed', '--issue', '42', ...args);
  const ids = p => p.selected.flatMap(f => f.scenarios.flatMap(s => s.ids)).sort();
  const payments = '.bdd/modules/api/payments/events.feature';
  const invoices = '.bdd/modules/api/invoices/events.feature';
  const cases = [
    '@PY-01 @#42 @API\nScenario: Refund leaves a receipt\nThen the refund receipt exists',
    '@PY-02 @#42 @API\nScenario: Receipt amount uses the new rate\nThen I see the converted amount',
    '@PY-03 @#3 @core @API\nScenario: A payment can be listed',
    '@PY-04 @#4 @API\nScenario: Receipt totals still balance',
    '@PY-05 @#5 @P0 @API\nScenario: A payment can be cancelled',
  ];
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  write('.gitignore', '/.bdd/42-feedback/\n');
  for (const [name, prefix, glob] of [['payments', 'PY', 'src/payments/**'], ['invoices', 'IN', 'src/invoices/**']]) {
    write('.bdd/modules/api/' + name + '/MODULE.md', ['---', 'prefix: ' + prefix, 'paths:', '  - ' + glob, '---'].join('\n'));
  }
  write(payments, 'Feature: Payments\n' + cases.join('\n\n') + '\n');
  write(invoices, 'Feature: Invoices\n@IN-01 @#6 @API\nScenario: Downstream invoice uses the receipt total\n' +
    '@IN-02 @#42 @API\nScenario: Prior invoice feedback can be viewed\n@IN-03 @#7 @core @API\nScenario: An invoice can be sent\n');
  const refund = 'src/payments/refund.js', receipt = 'src/payments/receipt.js', rounding = 'src/payments/rounding.js';
  for (const file of [refund, receipt, rounding]) write(file, '// original\n');
  const initial = commit('baseline');

  write(refund, '// first feedback: refund receipt\n');
  const beforeSecondBatch = commit('correct the refund receipt');
  const first = plan(initial, '--impact-scenario', refund + '=PY-01');
  assert.equal(first.bddStatus, 'PENDING');
  assert.deepEqual(ids(first), ['PY-01']);
  const priorOutput = '.bdd/42-feedback/first';
  fs.mkdirSync(path.join(repo, priorOutput), { recursive: true });
  run('verification', '--record', '--dir', priorOutput, '--base', initial, '--passed', '1',
    '--changed-scenarios', payments + '::PY-01');
  const priorFile = path.join(repo, priorOutput, 'verification.json');
  const priorEvidence = fs.readFileSync(priorFile, 'utf8');
  assert.equal(JSON.parse(priorEvidence).rounds[0].head, beforeSecondBatch);
  assert.deepEqual(JSON.parse(priorEvidence).rounds[0].scenarios[0].ids, ['PY-01']);

  write(receipt, '// second feedback: receipt conversion\n');
  const secondHead = commit('fix receipt conversion');
  const mapping = ['PY-02', 'PY-04', 'IN-01'].flatMap(id => ['--impact-scenario', receipt + '=' + id]);
  const second = plan(beforeSecondBatch, ...mapping);
  assert.equal(second.issueScope, 'batch');
  assert.equal(second.level, 'TARGETED');
  assert.equal(second.bddStatus, 'PENDING');
  assert.deepEqual(second.paths, [receipt]);
  assert.deepEqual([second.base, second.head], [beforeSecondBatch, secondHead]);
  assert.deepEqual(ids(second), ['IN-01', 'PY-02', 'PY-04']);
  assert.equal(fs.readFileSync(priorFile, 'utf8'), priorEvidence);
  const stale = spawnSync(process.execPath, [cli, 'quality-plan', '--base', beforeSecondBatch,
    '--issue', '42', '--review-reason', 'reviewed feedback', '--impact-scenario', refund + '=PY-01'], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /src\/payments\/refund\.js=PY-01/);
  const missing = plan(beforeSecondBatch);
  assert.equal(missing.bddStatus, 'BLOCKED');
  assert.ok(missing.blockers.length);
  assert.deepEqual(ids(missing), []);
  const issue = plan(beforeSecondBatch, '--issue-scope', 'issue', '--review-risk', 'MEDIUM');
  assert.deepEqual(ids(issue), ['IN-02', 'PY-01', 'PY-02', 'PY-03']);
  const issueWithoutDiff = plan(secondHead, '--issue-scope', 'issue');
  assert.equal(issueWithoutDiff.level, 'TARGETED');
  assert.equal(issueWithoutDiff.bddStatus, 'PENDING');
  assert.deepEqual(ids(issueWithoutDiff), ['IN-02', 'PY-01', 'PY-02']);
  assert.deepEqual(ids(plan(beforeSecondBatch, '--full')), ['IN-01', 'IN-02', 'IN-03', 'PY-01', 'PY-02', 'PY-03', 'PY-04', 'PY-05']);
  write(rounding, '// another changed source with unresolved impact\n');
  const partial = plan(beforeSecondBatch, ...mapping);
  assert.equal(partial.bddStatus, 'BLOCKED');
  assert.ok(partial.blockers.length);
  assert.ok(ids(partial).every(id => ['IN-01', 'PY-02', 'PY-04'].includes(id)));
  git('restore', '--', rounding);

  // A specification-only correction in the same feature must leave the prior feedback case out.
  write(payments, 'Feature: Payments\n' + cases.join('\n\n').replace('the converted amount', 'the rounded converted amount') + '\n');
  const featureOnly = plan(secondHead);
  assert.equal(featureOnly.bddStatus, 'PENDING');
  assert.deepEqual(ids(featureOnly), ['PY-02']);

  // A saved feedback snapshot can be ahead of a checkout restored to an earlier revision.
  const savedReview = commit('save corrected scenario before returning to the integration checkout');
  git('switch', '-q', '--detach', secondHead);
  const rollback = plan(savedReview);
  assert.deepEqual([rollback.base, rollback.head], [savedReview, secondHead]);
  assert.deepEqual(rollback.paths, [payments]);
  assert.equal(rollback.bddStatus, 'PENDING');
  assert.deepEqual(ids(rollback), ['PY-02']);
});

test('reviewed batch paths separate two uncommitted feedback fixes at the same HEAD', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-working-feedback-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trimEnd();
  const write = (name, text) => {
    fs.mkdirSync(path.join(repo, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
  };
  const feature = '.bdd/modules/api/orders/read.feature';
  const prior = 'src/orders/refund.js', current = 'src/orders/receipt.js', untouched = 'src/orders/send.js';
  const original = 'Feature: Orders\n@OR-01 @#1 @API\nScenario: Refund\nThen the refund is returned\n' +
    '@OR-02 @#1 @API\nScenario: Receipt\nThen the receipt is displayed\n@OR-03 @#3 @core @P0 @API\nScenario: Export\n';
  write(feature, original);
  write('.bdd/modules/api/orders/MODULE.md', '---\nprefix: OR\npaths:\n  - src/orders/**\n---\n');
  write('.gitignore', '/.bdd/1-feedback/\n');
  for (const name of [prior, current, untouched]) write(name, '// baseline\n');
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  const head = git('rev-parse', 'HEAD');
  const firstText = original.replace('refund is returned', 'refund is settled');
  write(feature, firstText);
  write(prior, '// earlier feedback\n');
  const firstPatch = git('diff', 'HEAD');
  const saved = '.bdd/1-feedback/prior.patch';
  write(saved, firstPatch);
  write(feature, firstText.replace('receipt is displayed', 'receipt displays the converted amount'));
  write(current, '// current feedback\n');
  const args = [cli, 'quality-plan', '--base', head, '--review-reason', 'Compared this request to the saved prior patch',
    '--issue', '1', '--static-passed', '--impact-complete'];
  const reviewed = ['--batch-path', current, '--batch-path', feature];
  const run = (...extra) => spawnSync(process.execPath, [...args, ...extra], { cwd: repo, encoding: 'utf8' });
  const json = (...extra) => {
    const p = run(...extra);
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  const sourceMapping = ['--impact-scenario', current + '=OR-02'];
  const mapped = json(...reviewed, ...sourceMapping, '--impact-scenario', feature + '=OR-02');
  assert.equal(mapped.head, head);
  assert.equal(mapped.bddStatus, 'PENDING');
  assert.deepEqual([...mapped.paths].sort(), [feature, current].sort());
  assert.deepEqual([...mapped.batchPaths].sort(), [feature, current].sort());
  assert.deepEqual([...mapped.allChangedPaths].sort(), [feature, prior, current].sort());
  assert.deepEqual(mapped.selected.flatMap(f => f.scenarios.flatMap(s => s.ids)), ['OR-02']);
  const unresolved = json(...reviewed, ...sourceMapping);
  assert.equal(unresolved.bddStatus, 'BLOCKED');
  assert.ok(unresolved.blockers.some(s => s.includes(feature)));
  assert.ok(unresolved.selected.flatMap(f => f.scenarios.flatMap(s => s.ids)).every(id => id === 'OR-02'));
  const full = json(...reviewed, '--full');
  assert.deepEqual(full.selected.flatMap(f => f.scenarios.flatMap(s => s.ids)), ['OR-01', 'OR-02', 'OR-03']);
  const wholeIssue = run(...reviewed, '--issue-scope', 'issue');
  assert.notEqual(wholeIssue.status, 0);
  assert.match(wholeIssue.stderr, /--batch-path/);
  for (const name of [untouched, 'missing.js']) {
    const invalid = run('--batch-path', name);
    assert.notEqual(invalid.status, 0);
    assert.ok(invalid.stderr.includes(name));
  }
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(repo, saved), 'utf8'), firstPatch);
});

test('mapped plans retain English aliases and flag partially indexed feature files', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-index-alias-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const modulePath = '.bdd/modules/api/orders';
  const dir = path.join(repo, modulePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MODULE.md'), '---\nprefix: OR\npaths:\n  - handler.js\n---');
  fs.writeFileSync(path.join(dir, 'chosen.feature'), [
    '@功能', 'Feature: selection', '@OR-01 @#1 @core @API', 'Scenario: chosen', 'Given the following document:',
    '"""text', 'Example: literal', '@OR-99 @#1 @UI', 'Scenario Template: literal', '"""',
    'And the same markdown:', '```', 'Example: literal', '```',
  ].join('\n'));
  const legacyFile = modulePath + '/legacy.feature';
  fs.writeFileSync(path.join(repo, legacyFile), [
    '@賬務', 'Feature: refunds', '@OR-02 @#2 @P1 @UI', 'Scenario: unrelated',
    '@OR-03 @#3 @P0 @API', 'Example: refunds preserve funds',
    '@OR-04 @#4 @P0 @DB', 'Scenario Template: refunds remain readable', 'Examples:', '| amount |', '| 20 |',
  ].join('\n'));
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  fs.writeFileSync(path.join(repo, 'handler.js'), 'changed');
  const options = { repo, base: 'HEAD', 'review-risk': 'MEDIUM', 'review-reason': 'reviewed callers',
    'impact-complete': true, 'static-passed': true, 'impact-scenario': ['handler.js=OR-01'] };
  const complete = buildQualityPlan(options);
  assert.equal(complete.scenarioImpact[0].selection, 'mapped');
  assert.deepEqual(complete.selected.flatMap(f => f.scenarios.map(s => [s.ids[0], s.methods[0]])),
    [['OR-01', 'API'], ['OR-03', 'API'], ['OR-04', 'DB']]);

  fs.appendFileSync(path.join(repo, legacyFile), '\n@OR-05 @#5 @P0 @API\n# comment\nDémonstration: unresolved case');
  git('add', '--', legacyFile);
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'existing unsupported header');
  const partial = buildQualityPlan(options);
  assert.equal(partial.scenarioImpact[0].selection, 'module');
  assert.deepEqual(partial.scenarioImpact[0].incompleteFeatures, [legacyFile]);
  const legacy = partial.selected.find(f => f.feature === legacyFile);
  assert.equal(legacy.requiresFullFeature, true);
  assert.deepEqual(legacy.unindexedScenarios, [{ line: 14, ids: ['OR-05'] }]);
  assert.deepEqual(legacy.scenarios.flatMap(s => s.ids), ['OR-02', 'OR-03', 'OR-04']);
  const byIssue = buildQualityPlan({ ...options, issue: '1', 'issue-scope': 'issue', 'impact-scenario': undefined });
  assert.equal(byIssue.selected.find(f => f.feature === legacyFile).requiresFullFeature, true);
  const index = moduleIndex(repo);
  assert.deepEqual(lint(index), []);
  assert.equal(nextId(index.modules[0]), 'OR-06');
  fs.appendFileSync(path.join(repo, legacyFile), '\n@OR-06 @#6\nScenario Template: alias without a method');
  assert.deepEqual(lint(moduleIndex(repo)).map(problem => problem.rule), ['missing-method-tag']);
});

test('reviewed file-to-scenario mappings narrow only fully covered modules', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-mapped-plan-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  const write = (file, content) => {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
  const args = ['quality-plan', '--repo', repo, '--base', 'HEAD', '--review-risk', 'MEDIUM',
    '--review-reason', 'reviewed endpoint handlers and callers', '--static-passed', '--impact-complete'];
  const mapping = ['--impact-scenario', 'src/shared.js=OR-01', '--impact-scenario', 'src/orders.js=OR-01'];
  function plan(...options) {
    return JSON.parse(execFileSync(process.execPath, [cli, ...args, ...options], { encoding: 'utf8' }));
  }
  const ids = (plan, name) => plan.selected.filter(f => f.module === name).flatMap(f => f.scenarios.flatMap(s => s.ids));
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  for (const [name, prefix] of [['orders', 'OR'], ['invoices', 'IN']]) {
    const dir = '.bdd/modules/api/' + name;
    write(dir + '/MODULE.md', ['---', 'prefix: ' + prefix, 'paths:', '  - src/' + name + '.js', '  - src/shared.js', '---'].join('\n'));
    const tags = ['@P2', '@core @P1', '@P0', '@P1', '@P2'];
    write(dir + '/read.feature', tags.map((tag, i) => '@' + prefix + '-0' + (i + 1) + ' @#' + (i + 1) + ' @API ' + tag + '\nScenario: case ' + (i + 1)).join('\n'));
  }
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  write('src/shared.js', 'changed shared handler');
  write('src/orders.js', 'changed order handler');
  const all = ['OR-01', 'OR-02', 'OR-03', 'OR-04', 'OR-05'];
  const mapped = plan(...mapping);
  assert.equal(mapped.level, 'TARGETED');
  assert.deepEqual(ids(mapped, 'api/orders'), ['OR-01', 'OR-02', 'OR-03']);
  assert.deepEqual(ids(mapped, 'api/invoices'), ['IN-01', 'IN-02', 'IN-03', 'IN-04', 'IN-05']);
  const orderScope = mapped.scenarioImpact.find(m => m.module === 'api/orders');
  assert.deepEqual(orderScope.mappings, [
    { path: 'src/orders.js', id: 'OR-01' }, { path: 'src/shared.js', id: 'OR-01' },
  ]);
  assert.deepEqual(mapped.scenarioImpact.find(m => m.module === 'api/invoices').unmappedPaths, ['src/shared.js']);
  if (process.platform === 'win32') {
    const wrapper = fileURLToPath(new URL('../scripts/bdd-quality-plan.ps1', import.meta.url));
    const script = "& $env:BDD_PLAN_WRAPPER -Repo $env:BDD_PLAN_FIXTURE -Base HEAD -ReviewRisk MEDIUM -ReviewReason fixture -StaticPassed -ImpactComplete -ImpactScenario @('src/shared.js=OR-01','src/orders.js=OR-01','src/orders.js=OR-05')";
    const powershellPlan = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', env: { ...process.env, BDD_PLAN_FIXTURE: repo, BDD_PLAN_WRAPPER: wrapper },
    }));
    assert.deepEqual(ids(powershellPlan, 'api/orders'), ['OR-01', 'OR-02', 'OR-03', 'OR-05']);
  }
  const wholeIssue = ['--issue', '4', '--issue-scope', 'issue'];
  assert.deepEqual(ids(plan(...wholeIssue, ...mapping), 'api/orders'), ['OR-01', 'OR-02', 'OR-03', 'OR-04']);
  assert.deepEqual(ids(plan(...wholeIssue, ...mapping.slice(0, 2)), 'api/orders'), all);
  assert.deepEqual(ids(plan(...mapping, '--full'), 'api/orders'), all);
  const highRisk = args.indexOf('MEDIUM');
  args[highRisk] = 'HIGH';
  assert.equal(plan(...mapping).level, 'FULL');
  args[highRisk] = 'MEDIUM';

  const feature = '.bdd/modules/api/orders/read.feature';
  fs.appendFileSync(path.join(repo, feature), '\n@OR-06 @#6 @API\nScenario: untagged-for-this-issue expectation');
  assert.deepEqual(ids(plan(...wholeIssue, ...mapping), 'api/orders'), [...all, 'OR-06']);
  const changedFeature = plan(...mapping);
  assert.equal(changedFeature.level, 'TARGETED');
  assert.deepEqual(ids(changedFeature, 'api/orders'), [...all, 'OR-06']);
  assert.deepEqual(changedFeature.scenarioImpact.find(m => m.module === 'api/orders').changedFeatures, [feature]);
  assert.equal(plan().level, 'FULL');
  const otherFeature = '.bdd/modules/api/invoices/read.feature';
  fs.appendFileSync(path.join(repo, otherFeature), '\n# no explicit source mapping for invoices');
  assert.equal(plan(...mapping).level, 'FULL');
  git('restore', '--', otherFeature);
  fs.unlinkSync(path.join(repo, feature));
  assert.equal(plan(...wholeIssue, '--impact-scenario', 'src/shared.js=IN-01').level, 'FULL');
  git('restore', '--', feature);
  write('unknown.js', 'changed external dependency');
  assert.equal(plan(...mapping, ...wholeIssue).level, 'FULL');
  const invalid = spawnSync(process.execPath, [cli, ...args, '--impact-scenario', 'src/orders.js=IN-01'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /IN-01/);
});

test('ESM lint reports manifest, orphan, prefix and scenario tag errors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-esm-lint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name, contents) {
    const file = path.join(root, '.bdd/modules', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const manifest = '\uFEFF---\nprefix: OR\npaths:\n  - src/**\n---';
  write('api/orders/MODULE.md', manifest);
  write('other/MODULE.md', manifest);
  write('broken/MODULE.md', 'no front matter');
  write('bad-prefix/MODULE.md', manifest.replace('prefix: OR', 'prefix: or'));
  write('no-paths/MODULE.md', '---\nprefix: NP\npaths:\n---');
  write('orphan/example.feature', 'Feature: orphan');
  write('api/orders/test.feature', [
    '@#1 @UI', 'Feature: resets feature tags',
    '@AB-02', 'Scenario: incorrect prefix and missing tags',
    '@AB-02 @#1 @UI', 'Scenario: duplicate',
    '@OR-01 @OR-02', 'Scenario: ambiguous',
    '@OR-1 @#1 @UI', 'Scenario: single-digit ID',
    '@#1 @UI', 'Scenario: missing ID',
  ].join('\n'));
  const rules = lint(moduleIndex(root)).map(p => p.rule).sort();
  assert.deepEqual(rules, [
    'module-format', 'module-format', 'module-format', 'duplicate-prefix', 'orphan-feature',
    'unknown-prefix', 'missing-issue-tag', 'missing-method-tag', 'unknown-prefix', 'duplicate-id',
    'scenario-id', 'scenario-id', 'scenario-id',
  ].sort());
});

test('module impact and quality plans include both rename endpoints and staged-only content', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-module-move-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--repo', repo], { encoding: 'utf8' }));
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  for (const [name, prefix] of [['orders', 'OR'], ['news', 'NW']]) {
    const mod = path.join(repo, '.bdd/modules/api', name);
    fs.mkdirSync(mod, { recursive: true });
    fs.writeFileSync(path.join(mod, 'MODULE.md'), '---\nprefix: ' + prefix + '\npaths:\n  - src/' + name + '/**\n---\n');
    fs.writeFileSync(path.join(mod, 'read.feature'), '@' + prefix + '-01 @#1 @API\nScenario: read');
    fs.mkdirSync(path.join(repo, 'src', name), { recursive: true });
  }
  const oldPath = 'src/orders/entry.js', newPath = 'src/news/entry.js', stagedPath = 'src/orders/settings.js';
  fs.writeFileSync(path.join(repo, oldPath), 'moved content');
  fs.writeFileSync(path.join(repo, stagedPath), 'original settings');
  git('add', '-f', '--', 'src', '.bdd/modules');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  git('mv', oldPath, newPath);
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'move entry');
  fs.writeFileSync(path.join(repo, stagedPath), 'staged settings');
  git('add', '--', stagedPath);
  fs.writeFileSync(path.join(repo, stagedPath), 'original settings');
  const paths = [newPath, oldPath, stagedPath];
  const modules = run('modules', '--base', base);
  assert.deepEqual(modules.modules, [{ name: 'api/news', files: [newPath] }, { name: 'api/orders', files: [oldPath, stagedPath] }]);
  const plan = run('quality-plan', '--base', base, '--review-risk', 'MEDIUM', '--review-reason', 'reviewed callers', '--impact-complete', '--static-passed');
  assert.deepEqual(plan.paths, paths);
  assert.deepEqual(plan.selected.map(row => row.module), modules.modules.map(row => row.name));
});

test('native module queries and quality plans share the same scenario index', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-module-cli-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  const dir = path.join(repo, '.bdd/modules/api/shared/orders');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MODULE.md'), [
    '---', 'prefix: OR', 'paths:', '  - src/**/訂單?.js', 'removed:', '  - OR-09 已移除', '---',
  ].join('\n'));
  const feature = path.join(dir, 'read.feature');
  fs.writeFileSync(feature, [
    '@OR', '功能：查詢', '@OR-01 @#8 @API', '場景：訂單', '@OR-02 @#1 @core @DB @UI',
    '場景大綱：core', '@OR-03 @#80 @UI', 'Scenario Outline: unrelated',
  ].join('\r\n'));
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  function run(code, command, ...args) {
    const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, command, '--repo', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, code, result.stderr);
    return result.stdout && JSON.parse(result.stdout);
  }
  assert.deepEqual(run(0, 'modules', '--lint').problems, []);
  assert.equal(run(0, 'modules', '--next-id', '--module', 'api/shared/orders').next, 'OR-10');
  assert.deepEqual(run(0, 'modules', '--path', 'src/訂單1.js', '--path', 'new file').unmatched, ['new file']);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/訂單1.js'), 'test');
  const plan = (...extra) => run(0, 'quality-plan', '--base', 'HEAD', '--review-risk', 'MEDIUM',
    '--review-reason', 'reviewed', '--static-passed', '--impact-complete', '--issue', '8', '--issue-scope', 'issue', ...extra);
  const targeted = plan();
  assert.equal(targeted.level, 'TARGETED');
  assert.deepEqual(targeted.selected[0].scenarios, [
    { line: 4, title: '訂單', tags: ['@OR-01', '@#8', '@API'], ids: ['OR-01'], methods: ['API'] },
    { line: 6, title: 'core', tags: ['@OR-02', '@#1', '@core', '@DB', '@UI'], ids: ['OR-02'], methods: ['DB', 'UI'] },
  ]);
  assert.equal(plan('--full').selected[0].scenarios.length, 3);
  fs.appendFileSync(feature, '\n# Reviewed the changed order handler and existing feature');
  const sharedPlan = plan();
  assert.equal(sharedPlan.level, 'TARGETED');
  assert.deepEqual(sharedPlan.selected[0].scenarios.flatMap(s => s.ids), ['OR-01', 'OR-02']);
  fs.appendFileSync(feature, '\n@OR-09 @#8 @API\n場景：已移除');
  assert.deepEqual(run(1, 'modules', '--lint').problems.map(p => p.rule), ['reused-id']);
  assert.equal(plan().bddStatus, 'BLOCKED');
  run(2, 'modules', '--lint', '--next-id');
  run(1, 'quality-plan', '--base', 'HEAD');
});
