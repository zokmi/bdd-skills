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
  const byIssue = buildQualityPlan({ ...options, issue: '1', 'impact-scenario': undefined });
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
  assert.deepEqual(ids(plan('--issue', '4', ...mapping), 'api/orders'), ['OR-01', 'OR-02', 'OR-03', 'OR-04']);
  assert.deepEqual(ids(plan('--issue', '4', ...mapping.slice(0, 2)), 'api/orders'), all);
  assert.deepEqual(ids(plan(...mapping, '--full'), 'api/orders'), all);
  const highRisk = args.indexOf('MEDIUM');
  args[highRisk] = 'HIGH';
  assert.equal(plan(...mapping).level, 'FULL');
  args[highRisk] = 'MEDIUM';

  const feature = '.bdd/modules/api/orders/read.feature';
  fs.appendFileSync(path.join(repo, feature), '\n@OR-06 @#6 @API\nScenario: untagged-for-this-issue expectation');
  assert.deepEqual(ids(plan('--issue', '4', ...mapping), 'api/orders'), [...all, 'OR-06']);
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
  assert.equal(plan('--issue', '4', '--impact-scenario', 'src/shared.js=IN-01').level, 'FULL');
  git('restore', '--', feature);
  write('unknown.js', 'changed external dependency');
  assert.equal(plan(...mapping, '--issue', '4').level, 'FULL');
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

test('native module queries and quality plans share the same scenario index', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-module-cli-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  const dir = path.join(repo, '.bdd/modules/api/orders');
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
  assert.equal(run(0, 'modules', '--next-id', '--module', 'api/orders').next, 'OR-10');
  assert.deepEqual(run(0, 'modules', '--path', 'src/訂單1.js', '--path', 'new file').unmatched, ['new file']);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/訂單1.js'), 'test');
  const plan = (...extra) => run(0, 'quality-plan', '--base', 'HEAD', '--review-risk', 'MEDIUM',
    '--review-reason', 'reviewed', '--static-passed', '--impact-complete', '--issue', '8', ...extra);
  const targeted = plan();
  assert.equal(targeted.level, 'TARGETED');
  assert.deepEqual(targeted.selected[0].scenarios, [
    { line: 4, title: '訂單', tags: ['@OR-01', '@#8', '@API'], ids: ['OR-01'], methods: ['API'] },
    { line: 6, title: 'core', tags: ['@OR-02', '@#1', '@core', '@DB', '@UI'], ids: ['OR-02'], methods: ['DB', 'UI'] },
  ]);
  assert.equal(plan('--full').selected[0].scenarios.length, 3);
  fs.appendFileSync(feature, '\n@OR-09 @#8 @API\n場景：已移除');
  assert.deepEqual(run(1, 'modules', '--lint').problems.map(p => p.rule), ['reused-id']);
  assert.equal(plan().bddStatus, 'BLOCKED');
  run(2, 'modules', '--lint', '--next-id');
  run(1, 'quality-plan', '--base', 'HEAD');
});
