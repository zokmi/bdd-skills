import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { moduleIndex } from '../scripts/lib/module-index.mjs';
import { lint } from '../scripts/lib/module-lint.mjs';

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
  write('orphan/example.feature', 'Feature: orphan');
  write('api/orders/test.feature', [
    '@#1 @UI', 'Feature: resets feature tags',
    '@AB-02', 'Scenario: incorrect prefix and missing tags',
    '@AB-02 @#1 @UI', 'Scenario: duplicate',
    '@OR-01 @OR-02', 'Scenario: ambiguous',
  ].join('\n'));
  const rules = lint(moduleIndex(root)).map(p => p.rule).sort();
  assert.deepEqual(rules, [
    'module-format', 'duplicate-prefix', 'orphan-feature', 'unknown-prefix', 'missing-issue-tag',
    'missing-method-tag', 'unknown-prefix', 'duplicate-id', 'scenario-id',
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
    '功能：查詢', '@OR-01 @#8 @API', '場景：訂單', '@OR-02 @#1 @core @DB',
    'Scenario Outline: core', '@OR-03 @#80 @UI', 'Scenario: unrelated',
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
  assert.equal(plan().level, 'TARGETED');
  assert.deepEqual(plan().selected[0].scenarios.map(s => s.ids[0]), ['OR-01', 'OR-02']);
  assert.equal(plan('--full').selected[0].scenarios.length, 3);
  fs.appendFileSync(feature, '\n@OR-09 @#8 @API\n場景：已移除');
  assert.deepEqual(run(1, 'modules', '--lint').problems.map(p => p.rule), ['reused-id']);
  assert.equal(plan().bddStatus, 'BLOCKED');
  run(2, 'modules', '--lint', '--next-id');
  run(1, 'quality-plan', '--base', 'HEAD');
});
