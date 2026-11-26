import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdd-native-archive-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const dir = path.join(repo, '.bdd', '123-中文');
  const root = path.join(base, 'store');
  const evidence = path.join(dir, 'evidence');
  await mkdir(evidence, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  const scenario = '.bdd/modules/reports/01.feature';
  await mkdir(path.dirname(path.join(repo, scenario)), { recursive: true });
  const feature = Buffer.from('Feature: 訂單匯出\n');
  await writeFile(path.join(repo, scenario), feature);
  git(repo, 'add', '--', scenario);
  git(repo, '-c', 'user.name=bdd-test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  const head = git(repo, 'rev-parse', 'HEAD');
  const blob = git(repo, 'rev-parse', 'HEAD:' + scenario);
  await writeFile(path.join(repo, scenario), 'working tree has diverged');
  await writeFile(path.join(dir, 'verification.json'), JSON.stringify({ rounds: [{ head, scenarios: [{ path: scenario, blob, role: 'changed' }] }] }));
  await writeFile(path.join(dir, 'REPORT.md'), '報告');
  await writeFile(path.join(evidence, '輪次.txt'), 'same evidence');
  await writeFile(path.join(evidence, '輪次-2.txt'), 'same evidence');
  const command = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, 'archive', '--dir', dir, '--archive-root', root, ...args],
      { windowsHide: true, env: { ...process.env, BDD_WEBP_ENCODER: 'none' } });
    return JSON.parse(stdout);
  };
  return { base, repo, dir, root, evidence, feature, head, command };
}

test('CLI snapshots the committed Git blob and restores logical duplicates from the verified archive', async t => {
  const f = await fixture(t);
  const r = await f.command();
  assert.equal(r.commit, f.head);
  assert.equal(r.aliasCount, 1);
  assert.equal(r.webpEncoder, null);
  assert.equal(r.sha256, createHash('sha256').update(await readFile(r.archive)).digest('hex').toUpperCase());
  const to = path.join(f.base, 'restored');
  await exec(process.execPath, [cli, 'extract', '--archive', r.archive, '--to', to], { windowsHide: true });
  const folder = path.join(to, path.basename(f.dir));
  assert.deepEqual(await readFile(path.join(folder, 'features/reports/01.feature')), f.feature);
  for (const name of ['輪次.txt', '輪次-2.txt']) {
    assert.equal(await readFile(path.join(folder, 'evidence', name), 'utf8'), 'same evidence');
  }
});

test('concurrent archives preserve both index events and supersede exactly one predecessor', async t => {
  const f = await fixture(t);
  const items = await Promise.all(['one', 'two'].map(name => f.command('--destination', path.join(f.root, name + '.zip'))));
  const events = (await readFile(items[0].index, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.event), ['created', 'created', 'status']);
  assert.equal(events[2].archive, events[0].archive);
  assert.equal(events[2].by, events[1].archive);
  assert.deepEqual(items.flatMap(i => i.superseded), [events[0].archive]);
  assert.deepEqual((await readdir(f.root)).sort(), ['index.jsonl', 'one.zip', 'two.zip']);
});

test('archiving the same group for different issues keeps each issue independently active', async t => {
  const f = await fixture(t);
  const archive = async (issue, label, ...args) => {
    const source = path.join(f.repo, '.bdd', issue + '-topic', 'groups', 'api');
    await mkdir(source, { recursive: true });
    for (const name of ['REPORT.md', 'verification.json', 'evidence']) {
      await cp(path.join(f.dir, name), path.join(source, name), { recursive: true });
    }
    return JSON.parse((await exec(process.execPath, [cli, 'archive', '--dir', source, '--archive-root', f.root,
      '--destination', path.join(f.root, label + '.zip'), ...args])).stdout);
  };
  const first = await archive('101', 'first', '--issue', '101');
  const other = await archive('202', 'other', '--issue', '202');
  assert.deepEqual(other.superseded, []);
  // Earlier group archives could have an empty issue, but kept the original source directory.
  const events = (await readFile(first.index, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  events[0].issue = '';
  await writeFile(first.index, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const next = await archive('101', 'next');
  assert.deepEqual(next.superseded, [first.archive]);
  const published = (await readFile(first.index, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(published.find(event => event.archive === next.archive && event.event === 'created').issue, '101');
});

test('restored parallel results retain usable masked evidence after WebP conversion', async t => {
  const f = await fixture(t);
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: f.repo })).stdout);
  const guide = await readFile(new URL('../references/parallel-bdd-contract.md', import.meta.url), 'utf8');
  const [assignment, result] = Array.from(guide.matchAll(/^\x60{3}json\r?\n([\s\S]*?)\r?\n\x60{3}/gm), m => JSON.parse(m[1]));
  const feature = '.bdd/modules/reports/01.feature';
  for (const s of [assignment.scenarios[0], result.scenarios[0]]) s.feature = feature;
  await writeFile(path.join(f.repo, feature), 'Feature: Report\n@' + assignment.scenarios[0].id + '\nScenario: View report\n');
  git(f.repo, '-c', 'user.name=bdd-test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'report scenario', '--', feature);
  const head = git(f.repo, 'rev-parse', 'HEAD');
  Object.assign(assignment.target, { repo: f.repo, workDir: f.repo, head });
  assignment.outputDir = f.dir;
  await run('verification', '--dir', f.dir, '--record', '--commits', head,
    '--changed-scenarios', feature + '::' + assignment.scenarios[0].id, '--passed', '1');
  result.verification.roundIndex = 1;
  const recordedPath = 'evidence/原圖.png';
  result.scenarios[0].evidence = [recordedPath];
  result.scenarios[0].actual = 'Observed ' + recordedPath;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAN0lEQVR4nO3RMQ0AMAzEQLf8OacQ3CWbD8BHcg4Mm+7qOh340A9UiVSJVIlUiVSJVIlUiVSJVIlUiVSJMA+hxgE/8m7SpQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(f.dir, recordedPath), image);
  await run('mask-evidence', '--dir', f.dir, '--mark', '--pattern', '原圖.png', '--method', 'exempt', '--note', 'Solid blue fixture');
  const attempt = path.join(f.dir, 'coordination', 'attempt-1');
  await mkdir(attempt, { recursive: true });
  const assignmentFile = path.join(attempt, 'assignment.json');
  const resultFile = path.join(attempt, 'result.json');
  await writeFile(assignmentFile, JSON.stringify(assignment));
  await writeFile(resultFile, JSON.stringify(result));
  const zip = await run('archive', '--dir', f.dir, '--archive-root', f.root, '--destination', path.join(f.root, 'converted.zip'));
  if (!zip.webpEncoder) return t.skip('Requires Python with Pillow WebP support');
  assert.equal(zip.webpConverted, 1);
  await rename(f.dir, path.join(f.base, 'before-extraction'));
  await run('extract', '--archive', zip.archive, '--to', path.dirname(f.dir));
  const restored = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.deepEqual(restored.scenarios[0].evidence, ['evidence/原圖.webp']);
  assert.equal(restored.scenarios[0].actual, result.scenarios[0].actual);
  const summary = name => run('parallel-summary', '--assignment', assignmentFile, '--output-dir', path.join(f.base, name));
  assert.equal((await summary('restored')).eligibleForReview, true);
  // Older converted archives kept the original path in the result and the mapping in masking.json.
  await writeFile(resultFile, JSON.stringify(result));
  assert.equal((await summary('historical')).eligibleForReview, true);
  const ledgerFile = path.join(f.dir, 'masking.json');
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
  const webpRecord = ledger.files['evidence/原圖.webp'];
  webpRecord.derivedFrom.name = 'evidence/unrelated.png';
  await writeFile(ledgerFile, JSON.stringify(ledger));
  const issue = pattern => err => JSON.parse(err.stdout).issues.some(s => pattern.test(s));
  await assert.rejects(summary('wrong-source'), issue(/Missing artifact/));
  webpRecord.derivedFrom.name = recordedPath;
  await writeFile(ledgerFile, JSON.stringify(ledger));
  await writeFile(path.join(f.evidence, '原圖.webp'), 'changed bytes');
  await assert.rejects(summary('changed'), issue(/Invalid image masking/));
});

test('a malformed index or unfinished mask operation leaves the archive unpublished', async t => {
  const f = await fixture(t);
  await mkdir(f.root);
  const index = path.join(f.root, 'index.jsonl');
  const archive = path.join(f.root, 'test.zip');
  await writeFile(index, 'bad index');
  await assert.rejects(f.command('--destination', archive));
  assert.deepEqual(await readdir(f.root), ['index.jsonl']);
  assert.equal(await readFile(index, 'utf8'), 'bad index');
  await writeFile(path.join(f.dir, 'masking.json.lock'), 'pending');
  await assert.rejects(f.command('--destination', archive), /稍後重試/);
  assert.deepEqual(await readdir(f.root), ['index.jsonl']);
});
