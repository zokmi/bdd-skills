import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureApprovedRevision } from '../scripts/lib/approved-revision.mjs';

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-approved-revision-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  const write = (name, data) => fs.writeFileSync(path.join(repo, name), data);
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'bdd@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  write('.gitignore', '/.bdd/output/\n');
  write('source', 'committed');
  git('add', '.');
  git('commit', '-qm', 'initial revision');
  return { repo, git, write, capture: () => captureApprovedRevision(repo) };
}

test('captures HEAD and ignores generated output without refreshing the Git index', t => {
  const { repo, git, write, capture } = fixture(t);
  fs.mkdirSync(path.join(repo, '.bdd/output'), { recursive: true });
  write('.bdd/output/report.json', 'first');
  const index = path.join(repo, '.git/index');
  const stamp = fs.statSync(index, { bigint: true }).mtimeNs;
  const head = git('rev-parse', 'HEAD');
  assert.deepEqual(capture(), { head, dirtySha256: null });
  write('.bdd/output/report.json', 'second');
  assert.deepEqual(capture(), { head, dirtySha256: null });
  assert.equal(fs.statSync(index, { bigint: true }).mtimeNs, stamp);
  git('commit', '--allow-empty', '-qm', 'next');
  assert.deepEqual(capture(), { head: git('rev-parse', 'HEAD'), dirtySha256: null });
  assert.throws(() => captureApprovedRevision(path.join(repo, '.bdd')), /root/i);
});

test('hashes untracked, staged and unstaged bytes even with identical names and status codes', t => {
  const { repo, git, write, capture } = fixture(t);
  const untracked = process.platform === 'win32' ? '[新 檔].bin' : 'line\n[新 檔].bin';
  write(untracked, Buffer.from([0x00, 0xfd]));
  const first = capture().dirtySha256;
  assert.match(first, /^[0-9a-f]{64}$/);
  write(untracked, Buffer.from([0x00, 0xfe]));
  assert.notEqual(capture().dirtySha256, first);
  write(untracked, Buffer.from([0x00, 0xfd]));
  assert.equal(capture().dirtySha256, first);
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(repo, untracked), 0o755);
    assert.notEqual(capture().dirtySha256, first);
    const link = path.join(repo, 'link');
    fs.symlinkSync('first-dangling-target', link);
    const withLink = capture().dirtySha256;
    fs.unlinkSync(link);
    fs.symlinkSync('second-dangling-target', link);
    assert.notEqual(capture().dirtySha256, withLink);
    fs.unlinkSync(link);
  }
  fs.unlinkSync(path.join(repo, untracked));
  write('source', 'staged one');
  git('add', 'source');
  write('source', 'committed');
  const stagedOne = capture().dirtySha256;
  assert.match(stagedOne, /^[0-9a-f]{64}$/);
  write('source', 'staged two');
  git('add', 'source');
  write('source', 'committed');
  assert.notEqual(capture().dirtySha256, stagedOne);
  write('source', 'working 1');
  const changed = capture().dirtySha256;
  write('source', 'working 2');
  assert.notEqual(capture().dirtySha256, changed);
  fs.unlinkSync(path.join(repo, 'source'));
  assert.match(capture().dirtySha256, /^[0-9a-f]{64}$/);
  git('restore', '--staged', '--worktree', 'source');
  assert.equal(capture().dirtySha256, null);
});

test('binds the checked-out submodule revision and its actual dirty content', t => {
  const { repo, git, write, capture } = fixture(t);
  git('init', '-q', 'nested');
  git('-C', 'nested', '-c', 'user.name=Fixture', '-c', 'user.email=bdd@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'nested');
  write('.gitmodules', '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n');
  git('add', '.gitmodules', 'nested');
  git('commit', '-qm', 'submodule');
  git('config', 'submodule.nested.ignore', 'all');
  assert.equal(capture().dirtySha256, null);
  fs.writeFileSync(path.join(repo, 'nested', 'source'), 'uncommitted');
  const first = capture().dirtySha256;
  assert.match(first, /^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(repo, 'nested', 'source'), 'different');
  assert.notEqual(capture().dirtySha256, first);
  fs.unlinkSync(path.join(repo, 'nested', 'source'));
  assert.equal(capture().dirtySha256, null);
  const advance = () => git('-C', 'nested', '-c', 'user.name=Fixture', '-c', 'user.email=bdd@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'next nested revision');
  advance();
  const newHead = capture().dirtySha256;
  assert.match(newHead, /^[0-9a-f]{64}$/);
  advance();
  assert.notEqual(capture().dirtySha256, newHead);
});
