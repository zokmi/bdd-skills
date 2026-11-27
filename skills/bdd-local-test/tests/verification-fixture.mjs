import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

export const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));

function removeDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

function gitIn(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let seed;
after(() => { if (seed) removeDirectory(seed.repo); });

function repositorySeed() {
  if (seed) return seed;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-verify-seed-'));
  try {
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'config', 'user.name', 'fixture');
    gitIn(repo, 'config', 'user.email', 'fixture@example.invalid');
    gitIn(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'readme'), 'base\n');
    gitIn(repo, 'add', '.');
    gitIn(repo, 'commit', '-qm', 'base');
    seed = { repo, base: gitIn(repo, 'rev-parse', 'HEAD') };
    return seed;
  } catch (error) {
    removeDirectory(repo);
    throw error;
  }
}

export function fixture(t) {
  const { repo: source, base } = repositorySeed();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-verify-'));
  t.after(() => removeDirectory(temp));
  const repo = path.join(temp, 'repo');
  const output = path.join(temp, 'output');
  // Each case can change its own refs, index, config and object database.
  fs.cpSync(source, repo, { recursive: true, verbatimSymlinks: true });
  fs.mkdirSync(output);
  const git = (...args) => gitIn(repo, ...args);
  const args = (...extra) => [cli, 'verification', '--dir', output, ...extra];
  function run(code, ...extra) {
    const res = spawnSync(process.execPath, args(...extra), { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, code, res.stderr + res.stdout);
    return res.stdout && JSON.parse(res.stdout);
  }
  return { repo, output, git, base, run, args };
}
