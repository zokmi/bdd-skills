const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cli = path.resolve(__dirname, '../scripts/bdd.cjs');

test('mcp-session reports a blocked preflight in JSON', () => {
  const result = spawnSync(process.execPath, [cli, 'mcp-session'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).status, 'blocked');
});

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd cli 測試-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, 'gitignore', '--repo', repo, ...args], { encoding: 'utf8' });
    assert.ok(result.stdout, result.stderr);
    return [result.status, JSON.parse(result.stdout)];
  };
  return { repo, git, run };
}

test('gitignore checks without writing, preserves bytes, and is idempotent', t => {
  const { repo, run } = fixture(t);
  const ignore = path.join(repo, '.gitignore');
  const original = Buffer.from('\uFEFF# 原規則\r\n/local');
  fs.writeFileSync(ignore, original);
  assert.equal(run('--check')[0], 1);
  assert.deepEqual(fs.readFileSync(ignore), original);
  const [status, applied] = run();
  assert.equal(status, 0);
  assert.equal(applied.updated, true);
  assert.deepEqual(fs.readFileSync(ignore).subarray(0, original.length), original);
  assert.equal(run()[1].updated, false);
});

test('gitignore reports tracked output and rolls back a conflicting nested rule', t => {
  const { repo, git, run } = fixture(t);
  const output = path.join(repo, '.bdd/run/REPORT.md');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, '');
  git('add', '-f', '.bdd/run/REPORT.md');
  fs.mkdirSync(path.join(repo, '.bdd/modules'));
  fs.writeFileSync(path.join(repo, '.bdd/modules/.gitignore'), '*.feature\n');
  assert.equal(run()[0], 2);
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);
  fs.unlinkSync(path.join(repo, '.bdd/modules/.gitignore'));
  const [status, result] = run();
  assert.equal(status, 1);
  assert.deepEqual(result.trackedOutputs, ['.bdd/run/REPORT.md']);
});
