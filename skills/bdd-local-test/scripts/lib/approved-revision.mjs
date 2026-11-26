import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './verification-git.mjs';

const changedWhileReading = () => new Error('Checkout changed while capturing the approved revision; retry.');

export function readStatus(repo) {
  const raw = execFileSync('git', ['-C', repo, '--no-optional-locks', '-c', 'core.fsmonitor=false',
    'status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind', '--no-renames',
    '--ignore-submodules=none', '--untracked-files=all'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  // A lossy filename decode could bind a different path in the working tree.
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0').filter(Boolean);
  const head = entries.find(row => row.startsWith('# branch.oid '))?.slice('# branch.oid '.length);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head ?? '')) throw new Error('Expected a committed HEAD for the approved revision.');
  return { head, entries: entries.filter(row => !row.startsWith('# ')) };
}

function workingEntry(row) {
  if (row.startsWith('? ')) return { name: row.slice(2), submodule: false };
  if (row.startsWith('u ')) throw new Error('Resolve the unmerged index before capturing the approved revision.');
  // Ordinary porcelain v2 records include the modes and the HEAD and index blob IDs.
  const match = /^1 \S+ \S+ \d+ \d+ (\d+) [0-9a-f]+ [0-9a-f]+ ([\s\S]+)$/.exec(row);
  if (!match) throw new Error('Unexpected Git status record while capturing the approved revision.');
  return match[1] === '000000' ? null : { name: match[2], submodule: match[1] === '160000' };
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function fileDigest(file, stat, buffer) {
  const hash = createHash('sha256');
  if (stat.isSymbolicLink()) return hash.update('link\0').update(fs.readlinkSync(file, { encoding: 'buffer' })).digest('hex');
  if (!stat.isFile()) throw new Error('Cannot capture a changed directory, embedded repository or special file: ' + file);
  hash.update((stat.mode & 0o100n) !== 0n ? 'executable\0' : 'file\0');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    if (!sameFile(stat, fs.fstatSync(fd, { bigint: true }))) throw changedWhileReading();
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function captureCheckout(root, checkouts, files, buffer) {
  const coordinates = git(root, ['rev-parse', '--show-prefix', 'HEAD']).split(/\r?\n/);
  if (coordinates.length !== 3 || coordinates[0] !== '') {
    throw new Error('Approved repo must be the checkout root.');
  }
  const { head, entries } = readStatus(root);
  if (coordinates[1] !== head) throw changedWhileReading();
  checkouts.set(root, { head, entries });
  if (!entries.length) return { head, dirtySha256: null };
  const hash = createHash('sha256').update('bdd-approved-revision-v1\0');
  for (const row of entries) {
    hash.update(row).update('\0');
    const entry = workingEntry(row);
    if (!entry) continue;
    const file = path.join(root, entry.name);
    const parent = path.dirname(file);
    if (path.relative(parent, fs.realpathSync.native(parent))) throw changedWhileReading();
    const stat = fs.lstatSync(file, { bigint: true });
    if (entry.submodule) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a submodule checkout at ' + file);
      const nested = captureCheckout(file, checkouts, files, buffer);
      hash.update(JSON.stringify(nested)).update('\0');
    } else {
      files.set(file, stat);
      hash.update(fileDigest(file, stat, buffer)).update('\0');
    }
  }
  return { head, dirtySha256: hash.digest('hex') };
}

// Bind both the staged blob IDs and the bytes that the application sees on disk.
// Neither file contents nor the list of dirty paths is included in the plan.
export function captureApprovedRevision(repo) {
  const checkouts = new Map();
  const files = new Map();
  const snapshot = captureCheckout(fs.realpathSync.native(repo), checkouts, files, Buffer.allocUnsafe(64 * 1024));
  if (snapshot.dirtySha256 === null) return snapshot;
  for (const [root, { head, entries }] of checkouts) {
    const after = readStatus(root);
    if (head !== after.head || entries.length !== after.entries.length ||
        entries.some((row, index) => row !== after.entries[index])) throw changedWhileReading();
  }
  for (const [file, stat] of files) {
    if (!sameFile(stat, fs.lstatSync(file, { bigint: true }))) throw changedWhileReading();
  }
  return snapshot;
}
