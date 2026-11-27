import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const fullCommitId = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const emptyBlobIds = new Set(['sha1', 'sha256'].map(algo => createHash(algo).update('blob 0\0').digest('hex')));

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

export function readStatus(repo) {
  const raw = execFileSync('git', ['-C', repo, '--no-optional-locks', '-c', 'core.fsmonitor=false',
    'status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind', '--no-renames',
    '--ignore-submodules=none', '--untracked-files=all'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  // A lossy filename decode could bind a different path in the working tree.
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0').filter(Boolean);
  const head = entries.find(row => row.startsWith('# branch.oid '))?.slice('# branch.oid '.length);
  if (!fullCommitId.test(head ?? '')) throw new Error('Expected a committed HEAD for the approved revision.');
  return { head, entries: entries.filter(row => !row.startsWith('# ')) };
}

function worktreePaths(repo, head) {
  let status;
  try { status = readStatus(repo); } catch { return null; }
  if (status.head !== head) return null;
  const paths = [];
  for (const row of status.entries) {
    if (row.startsWith('? ')) {
      paths.push(row.slice(2));
      continue;
    }
    // Preserve Git diff's configured submodule behavior, including gitlink type changes.
    // An unmerged index has separate stages and needs the original pinned-commit diffs.
    const fields = /^1 (?<xy>..) N\.\.\. (?<modes>\d{6} \d{6} \d{6}) (?<headBlob>[0-9a-f]+) [0-9a-f]+ (?<path>[\s\S]+)$/.exec(row)?.groups;
    if (!fields || fields.modes.includes('160000')) return null;
    // Git reports a removed intent-to-add as an unstaged deletion of the empty
    // blob, even though both diffs against HEAD are empty.
    if (fields.xy === '.D' && emptyBlobIds.has(fields.headBlob)) return null;
    paths.push(fields.path);
  }
  return paths;
}

export function changedPaths(repo, baseline, head) {
  const options = ['--name-only', '--no-renames', '-z'];
  const pinned = fullCommitId.test(head);
  const history = baseline === head && pinned ? [] : git(repo, 'diff', ...options, baseline + '...' + head, '--').split('\0').filter(Boolean);
  const merge = paths => [...new Set([...history, ...paths])].sort((a, b) => a.localeCompare(b));
  const working = pinned ? worktreePaths(repo, head) : null;
  if (working) {
    const merged = merge(working);
    // The previous stable sort keeps Git's diff/staged/untracked order for
    // distinct filenames that collate equally (e.g. NFC and NFD spellings).
    if (merged.every((name, i) => i === 0 || name.localeCompare(merged[i - 1]) !== 0)) return merged;
  }
  return merge([
    git(repo, 'diff', ...options, head, '--'),
    git(repo, 'diff', '--cached', ...options, head, '--'),
    git(repo, 'ls-files', '-z', '--others', '--exclude-standard'),
  ].flatMap(output => output.split('\0').filter(Boolean)));
}
