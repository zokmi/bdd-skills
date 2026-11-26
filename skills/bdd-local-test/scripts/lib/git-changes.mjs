import { execFileSync } from 'node:child_process';
import path from 'node:path';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
}

export function commit(repo, ref) {
  return git(repo, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').trim();
}

export function repoRoot(repo) {
  return path.resolve(git(repo, 'rev-parse', '--show-toplevel').trimEnd());
}

export function changedPaths(repo, baseline, head) {
  const options = ['--name-only', '--no-renames', '-z'];
  const outputs = [
    git(repo, 'diff', ...options, baseline + '...' + head, '--'),
    git(repo, 'diff', ...options, head, '--'),
    git(repo, 'diff', '--cached', ...options, head, '--'),
    git(repo, 'ls-files', '-z', '--others', '--exclude-standard'),
  ];
  return [...new Set(outputs.flatMap(output => output.split('\0').filter(Boolean)))].sort((a, b) => a.localeCompare(b));
}
