import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { moduleIndex, nextId } from '../scripts/lib/module-index.mjs';
import { modulesCommand } from '../scripts/lib/module-query.mjs';
import { lint } from '../scripts/lib/module-lint.mjs';
import { buildQualityPlan } from '../scripts/lib/quality-plan.mjs';
import { readGitBlobs } from '../scripts/lib/git-blobs.mjs';
import { verificationCommand } from '../scripts/lib/verification.mjs';

test('batched Git reads preserve empty, repeated and individually large blobs', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-git-blobs-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const empty = Buffer.alloc(0);
  const large = Buffer.alloc(9 * 1024 * 1024, 0xff);
  large[large.length - 1] = 10;
  const inputs = [empty, large, empty];
  const entries = inputs.map(bytes => ({
    oid: execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: bytes, encoding: 'utf8' }).trim(),
    size: bytes.length,
  }));
  let index = 0;
  for (const blob of readGitBlobs(repo, entries)) {
    assert.equal(blob.oid, entries[index].oid);
    assert.ok(blob.bytes.equals(inputs[index++]));
  }
  assert.equal(index, inputs.length);
});

test('feedback selection reads old Feature blobs in one process and preserves mapping decisions', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-feedback-blobs-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  const dir = '.bdd/modules/orders';
  fs.mkdirSync(path.join(repo, dir), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = (name, text) => fs.writeFileSync(path.join(repo, dir, name), text);
  const scenario = (id, result) => '@OR-' + id + ' @#42 @API\nScenario: 訂單 ' + id + '\nThen ' + result;
  const content = (id, result) => 'Feature: 訂單\n# zero\0byte\n' + scenario(id, result);
  write('MODULE.md', '---\nprefix: OR\npaths:\n  - src/**\n---\n');
  write('a.feature', content('01', '已付款💰'));
  write('b.feature', content('02', '付款') + '\n' + scenario('03', '出貨'));
  write('c.feature', content('04', '取消'));
  write('舊模式.feature', content('06', '查詢'));
  git('add', '.');
  const oldPath = dir + '/舊模式.feature';
  const oid = git('rev-parse', ':' + oldPath);
  git('update-index', '--cacheinfo', '120000', oid, oldPath);
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline');
  git('rm', '--cached', '--quiet', '--', oldPath);
  write('a.feature', content('01', '已退款💸'));
  write('b.feature', content('02', '付款'));
  write('c.feature', content('04', '取消').replace('Feature: 訂單', 'Feature: 客戶訂單'));
  write('new.feature', content('05', '新增'));

  const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
  const trace = path.join(tmp, 'trace.ndjson');
  const result = spawnSync(process.execPath, [cli, 'quality-plan', '--base', 'HEAD', '--issue', '42',
    '--review-reason', 'reviewed changed specifications', '--impact-complete', '--static-passed'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.bddStatus, 'BLOCKED');
  assert.deepEqual(plan.selected.flatMap(f => f.scenarios.flatMap(s => s.ids)).sort(), ['OR-01', 'OR-05']);
  for (const file of ['b.feature', 'c.feature', '舊模式.feature']) assert.ok(plan.blockers[0].includes(dir + '/' + file));
  const blobCalls = fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.event === 'start' && event.argv.includes('cat-file'));
  assert.equal(blobCalls.length, 1);
  assert.ok(blobCalls[0].argv.includes('--batch'));

  const reads = [];
  const readFile = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (typeof file === 'string' && file.endsWith('.feature')) reads.push(path.basename(file));
    return readFile(file, ...args);
  });
  assert.deepEqual(buildQualityPlan({ repo, base: 'HEAD', issue: '42', 'review-reason': 'reviewed changed specifications',
    'impact-complete': true, 'static-passed': true }), plan);
  assert.deepEqual(reads.sort(), ['a.feature', 'b.feature', 'c.feature', 'new.feature', '舊模式.feature'].sort());
});

test('record reuses stable working Feature IDs across roles and re-reads a replaced file', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-record-feature-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo');
  const output = path.join(tmp, 'output');
  fs.mkdirSync(repo);
  fs.mkdirSync(output);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'core.longpaths', 'true');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-qm', 'baseline');
  const feature = path.join(repo, 'orders.feature');
  const content = id => 'Feature: Orders\n@' + id + '\nScenario: Order status\n';
  fs.writeFileSync(feature, content('OR-01'));
  fs.writeFileSync(path.join(repo, 'other.feature'), content('OT-01'));
  const replacement = path.join(tmp, 'replacement');
  fs.writeFileSync(replacement, content('OR-02'));
  const fds = new Map();
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = open(file, ...args);
    fds.set(fd, file);
    return fd;
  });
  let reads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const name = typeof file === 'number' ? fds.get(file) : file;
    const bytes = read(file, ...args);
    if (typeof name === 'string' && path.basename(name) === 'orders.feature') reads++;
    if (typeof name === 'string' && path.basename(name) === 'other.feature') fs.renameSync(replacement, feature);
    return bytes;
  });
  let round;
  t.mock.method(console, 'log', text => { round = JSON.parse(text); });
  const cwd = process.cwd();
  try {
    process.chdir(repo);
    assert.equal(await verificationCommand(['--record', '--dir', output, '--base', 'HEAD',
      '--changed-scenarios', 'orders.feature::or-01,or-01;orders.feature;other.feature;orders.feature::OR-02',
      '--regression-scenarios', 'orders.feature::OR-02;orders.feature']), 0);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(reads, 2);
  assert.deepEqual(round.scenarios.map(({ path, ids, role, blob }) => [path, ids, role, blob]), [
    ['orders.feature', ['or-01', 'or-01'], 'changed', null], ['orders.feature', ['OR-01'], 'changed', null],
    ['other.feature', ['OT-01'], 'changed', null], ['orders.feature', ['OR-02'], 'changed', null],
    ['orders.feature', ['OR-02'], 'regression', null],
    ['orders.feature', ['OR-02'], 'regression', null],
  ]);
});

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

  const selectionPath = path.join(repo, priorOutput, 'second-selection.json');
  const selectionArgs = ['--run-id', '42-R2', '--output', selectionPath];
  const reference = plan(secondHead, ...selectionArgs);
  const selectionBytes = fs.readFileSync(reference.path);
  const saved = JSON.parse(selectionBytes);
  assert.equal(reference.sha256, createHash('sha256').update(selectionBytes).digest('hex'));
  assert.equal(saved.runId, '42-R2');
  assert.equal(saved.repo, fs.realpathSync.native(repo));
  assert.deepEqual(ids(saved), ['PY-02']);
  assert.deepEqual(saved.revision, run('parallel-plan', '--revision', repo));
  assert.ok(saved.revision.dirtySha256);
  const invalidOutput = (file, base) => spawnSync(process.execPath, [cli, 'quality-plan', '--base', base,
    '--issue', '42', '--review-reason', 'batch two', '--static-passed', '--impact-complete',
    '--run-id', '42-R2', '--output', file], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(invalidOutput(selectionPath, secondHead).status, 0);
  assert.deepEqual(fs.readFileSync(selectionPath), selectionBytes);
  const visibleFile = path.join(repo, 'selected.json');
  assert.notEqual(invalidOutput(visibleFile, secondHead).status, 0);
  assert.equal(fs.existsSync(visibleFile), false);
  const blockedFile = path.join(repo, priorOutput, 'blocked.json');
  assert.match(invalidOutput(blockedFile, initial).stderr, /BLOCKED/);
  assert.equal(fs.existsSync(blockedFile), false);

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

test('module lint checks localized scenarios and reports both locations of a duplicate ID', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-localized-lint-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const dir = '.bdd/modules/api/orders';
  fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, dir, 'MODULE.md'), '---\nprefix: OR\npaths:\n  - orders.js\nremoved:\n  - or-01\n  - OR-01\n---');
  const feature = dir + '/orders.feature';
  fs.writeFileSync(path.join(repo, feature), [
    'Feature: Orders', '@OR-01 @API @#1', '情境：已成立的訂單',
    '@OR-01 @UI @#1', 'Scenario: Existing order',
    '@OR-02', 'Scénario: An order can be edited',
    '@API @#1', '场景大纲：查詢訂單',
    '@OR-01 @API @#1', 'Unrecognized heading: needs manual review',
  ].join('\n'));
  const index = moduleIndex(repo);
  const problems = lint(index);
  assert.deepEqual(problems.map(p => [p.rule, p.file, p.line]), [
    ['reused-id', feature, 3],
    ['duplicate-id', feature, 5],
    ['reused-id', feature, 5],
    ['missing-issue-tag', feature, 7],
    ['missing-method-tag', feature, 7],
    ['scenario-id', feature, 9],
  ]);
  assert.ok(problems[1].message.includes(feature + ':3'));
  assert.ok(problems[1].message.includes(feature + ':5'));
  const [parsed] = index.modules[0].features();
  assert.equal(parsed.requiresFullFeature, true);
  assert.ok(parsed.unindexedScenarios.some(row => row.line === 11 && row.unattached));
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
  assert.deepEqual(legacy.unindexedScenarios.map(row => [row.line, row.ids]), [[14, ['OR-05']]]);
  assert.deepEqual(legacy.scenarios.flatMap(s => s.ids), ['OR-02', 'OR-03', 'OR-04']);
  const byIssue = buildQualityPlan({ ...options, issue: '1', 'issue-scope': 'issue', 'impact-scenario': undefined });
  assert.equal(byIssue.selected.find(f => f.feature === legacyFile).requiresFullFeature, true);
  const index = moduleIndex(repo);
  assert.deepEqual(lint(index), []);
  assert.equal(nextId(index.modules[0]), 'OR-06');
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-full-selection-'));
  t.after(() => fs.rmSync(artifacts, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
  const exportFull = name => spawnSync(process.execPath, [cli, 'quality-plan', '--repo', repo, '--base', 'HEAD',
    '--issue', '1', '--full', '--review-reason', 'full regression', '--static-passed', '--run-id', '1-R2',
    '--output', path.join(artifacts, name)], { encoding: 'utf8' });
  const full = exportFull('complete.json');
  assert.equal(full.status, 0, full.stderr);
  const bound = JSON.parse(fs.readFileSync(JSON.parse(full.stdout).path));
  assert.deepEqual(bound.selected.flatMap(f => f.scenarios.flatMap(s => s.ids)).sort(),
    ['OR-01', 'OR-02', 'OR-03', 'OR-04', 'OR-05']);
  const savedFeature = fs.readFileSync(path.join(repo, legacyFile));
  fs.appendFileSync(path.join(repo, legacyFile), '\n"""\norphaned doc string');
  assert.notEqual(exportFull('incomplete.json').status, 0);
  assert.equal(fs.existsSync(path.join(artifacts, 'incomplete.json')), false);
  fs.writeFileSync(path.join(repo, legacyFile), savedFeature);
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
  const multipleIds = plan(...mapping, '--impact-scenario', 'src/orders.js=OR-05');
  assert.deepEqual(ids(multipleIds, 'api/orders'), ['OR-01', 'OR-02', 'OR-03', 'OR-05']);
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
    const glob = name === 'news' ? 'src/news/*.js' : 'src/orders/**';
    fs.writeFileSync(path.join(mod, 'MODULE.md'), '---\nprefix: ' + prefix + '\npaths:\n  - ' + glob + '\n---\n');
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
  const byPath = run('modules', '--path', 'SRC/ORDERS/nested/entry.js', '--path', newPath,
    '--path', '.bdd/42-run/REPORT.md', '--path', 'src/news/deep/entry.js', '--path', 'other.txt');
  assert.deepEqual(byPath.modules.map(m => m.name), ['api/news', 'api/orders']);
  assert.deepEqual(byPath.unmatched, ['other.txt', 'src/news/deep/entry.js']);
  const plan = run('quality-plan', '--base', base, '--review-risk', 'MEDIUM', '--review-reason', 'reviewed callers', '--impact-complete', '--static-passed');
  assert.deepEqual(plan.paths, paths);
  assert.deepEqual(plan.selected.map(row => row.module), modules.modules.map(row => row.name));
});

test('next-id reads only the requested module and preserves removed and reserved IDs', t => {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-next-id-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  const root = path.join(repo, '.bdd', 'modules');
  const selected = path.join(root, 'API', 'Orders');
  const manifest = '---\nprefix: OR\nremoved:\n  - OR-12\n---';
  for (const dir of [root, selected, path.join(selected, 'Nested'), path.join(root, 'Other', 'Orders')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'module.MD'), manifest);
    fs.writeFileSync(path.join(dir, 'orders.feature'), dir === selected ? '@OR-15' : '@OR-02');
  }
  const reads = [], visits = [], output = [];
  const read = fs.readFileSync, list = fs.readdirSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { reads.push(file); return read(file, ...args); });
  t.mock.method(fs, 'readdirSync', (dir, ...args) => { visits.push(dir); return list(dir, ...args); });
  t.mock.method(console, 'log', value => output.push(JSON.parse(value)));
  const run = name => modulesCommand(['--repo', repo, '--next-id', '--module', name]);
  assert.equal(run('api\\ORDERS'), 0);
  assert.deepEqual(output[0], { module: 'API/Orders', prefix: 'OR', next: 'OR-16' });
  assert.deepEqual(reads.map(file => path.relative(selected, file)), ['module.MD', 'orders.feature']);
  assert.deepEqual(visits.map(dir => path.relative(root, dir)), ['', 'API', path.join('API', 'Orders')]);
  assert.equal(run('.'), 0);
  assert.deepEqual(output[1], { module: '.', prefix: 'OR', next: 'OR-13' });
  assert.throws(() => run('../Other/Orders'), /找不到模組/);
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
  run(2, 'modules');
  run(2, 'modules', '--next-id', '--module', 'missing');
  assert.equal(run(0, 'modules', '--next-id', '--module', 'api/shared/orders').next, 'OR-10');
  assert.deepEqual(run(0, 'modules', '--path', 'src/訂單1.js', '--path', 'new file').unmatched, ['new file']);
  const readme = path.join(repo, 'README.md');
  fs.writeFileSync(readme, 'documentation only');
  const fast = run(0, 'quality-plan', '--base', 'HEAD', '--review-risk', 'LOW', '--review-reason', 'docs only', '--static-passed');
  assert.deepEqual([fast.level, fast.bddStatus, fast.selected], ['FAST', 'SKIPPED', []]);
  fs.unlinkSync(readme);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/訂單1.js'), 'test');
  git('config', 'core.quotepath', 'true');
  assert.deepEqual(run(0, 'modules', '--base', 'HEAD').modules[0].files, ['src/訂單1.js']);
  const plan = (...extra) => run(0, 'quality-plan', '--base', 'HEAD', '--review-risk', 'MEDIUM',
    '--review-reason', 'reviewed', '--static-passed', '--impact-complete', '--issue', '8', '--issue-scope', 'issue', ...extra);
  const targeted = plan();
  assert.equal(targeted.level, 'TARGETED');
  assert.deepEqual(targeted.selected[0].scenarios, [
    { line: 4, title: '訂單', tags: ['@OR-01', '@#8', '@API'], ids: ['OR-01'], methods: ['API'] },
    { line: 6, title: 'core', tags: ['@OR-02', '@#1', '@core', '@DB', '@UI'], ids: ['OR-02'], methods: ['DB', 'UI'] },
  ]);
  assert.equal(plan('--full').selected[0].scenarios.length, 3);
  const normal = (...extra) => run(0, 'quality-plan', '--base', 'HEAD', '--review-reason', 'reviewed',
    '--static-passed', '--impact-complete', ...extra);
  assert.equal(normal('--review-risk', 'MEDIUM').level, 'TARGETED');
  assert.equal(normal('--review-risk', 'MEDIUM', '--issue', '99', '--issue-scope', 'issue').selected[0].scenarios.length, 3);
  assert.equal(normal('--review-risk', 'HIGH').level, 'FULL');
  const config = path.join(repo, '.bdd/config.json');
  fs.writeFileSync(config, '{}');
  assert.equal(normal('--review-risk', 'MEDIUM').level, 'FULL');
  fs.unlinkSync(config);
  fs.appendFileSync(feature, '\n# Reviewed the changed order handler and existing feature');
  const sharedPlan = plan();
  assert.equal(sharedPlan.level, 'TARGETED');
  assert.deepEqual(sharedPlan.selected[0].scenarios.flatMap(s => s.ids), ['OR-01', 'OR-02']);
  fs.appendFileSync(feature, '\n@OR-09 @#8 @API\n場景：已移除');
  assert.deepEqual(run(1, 'modules', '--lint').problems.map(p => p.rule), ['reused-id']);
  assert.equal(plan().bddStatus, 'BLOCKED');
  run(2, 'modules', '--lint', '--next-id');
  run(1, 'quality-plan', '--base', 'HEAD');
  const emptyModule = path.join(repo, '.bdd/modules/empty');
  fs.mkdirSync(emptyModule);
  fs.writeFileSync(path.join(emptyModule, 'MODULE.md'), '---\nprefix: MT\npaths:\n  - other/**\n---\n');
  assert.equal(run(0, 'modules', '--next-id', '--module', 'empty').next, 'MT-01');
});
