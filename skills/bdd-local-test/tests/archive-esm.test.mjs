import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
