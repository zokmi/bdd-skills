import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));

export function worktreeFixture({ defaultRegistry = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-worktrees-')));
  const env = { ...process.env };
  if (defaultRegistry) delete env.BDD_LOOPBACK_REGISTRY_DIR;
  else env.BDD_LOOPBACK_REGISTRY_DIR = path.join(root, 'registry');

  function git(...args) {
    return execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
  }
  function init(name) {
    const repo = path.join(root, name);
    git('init', '-q', repo);
    git('-C', repo, '-c', 'user.name=BDD', '-c', 'user.email=bdd@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-qm', 'fixture');
    return repo;
  }
  function worktree(repo, name) {
    const target = path.join(root, name);
    git('-C', repo, 'worktree', 'add', '--quiet', '--detach', target, 'HEAD');
    return target;
  }
  async function bdd(cwd, ...args) {
    const { stdout } = await run(process.execPath, [cli, ...args], { cwd, env, windowsHide: true, timeout: 90000 });
    return JSON.parse(stdout);
  }
  function clean() {
    // Chromium and its daemon can briefly retain directory handles after close returns on Windows.
    return fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  return { root, init, worktree, git, bdd, clean };
}
