import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { commit } from './git-changes.mjs';

function command(root, args) {
  return ['-C', root, '--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args];
}

export function git(root, args, allowed = [0], input) {
  const result = spawnSync('git', command(root, args), {
    input, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowed.includes(result.status)) throw new Error(result.stderr.trim() || 'git ' + args[0] + ' failed');
  return result.status === 0 ? result.stdout : null;
}

export function repoIdentity(root) {
  const remotes = git(root, ['remote']).trim().split(/\r?\n/).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  return { name: path.basename(root), url: remote ? git(root, ['remote', 'get-url', '--', remote]).trim() : '' };
}

// Feed complete commit diffs directly into Git. Large binary patches never enter JS memory.
async function patchIds(root, shas) {
  if (!shas.length) return new Map();
  const child = args => spawn('git', command(root, args), { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const show = child(['show', '--stdin', '--no-walk=unsorted', '--no-color', '--format=commit %H', '--patch']);
  const ids = child(['patch-id', '--stable']);
  function completed(proc) {
    return new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', code => code === 0 ? resolve() : reject(new Error('git patch-id pipeline failed: ' + code)));
    });
  }
  const chunks = [];
  ids.stdout.on('data', chunk => chunks.push(chunk));
  const work = Promise.all([
    completed(show), completed(ids), pipeline(show.stdout, ids.stdin),
    pipeline([shas.join('\n') + '\n'], show.stdin),
  ]);
  try { await work; } finally { show.kill(); ids.kill(); }
  const map = new Map();
  for (const line of Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/)) {
    const [patchId, sha] = line.split(' ');
    if (sha) map.set(sha, patchId);
  }
  return map;
}

function* readCommitBatches(root, args, shas) {
  if (!shas.length) return;
  try {
    yield git(root, [...args, '--stdin', '--no-walk=unsorted', '--'], [0], shas.join('\n') + '\n');
  } catch (error) {
    // Keep the per-process output limit even when the combined history exceeds it.
    if (error.code !== 'ENOBUFS' || shas.length === 1) throw error;
    const middle = Math.floor(shas.length / 2);
    yield* readCommitBatches(root, args, shas.slice(0, middle));
    yield* readCommitBatches(root, args, shas.slice(middle));
  }
}

export async function commitInfo(root, shas) {
  const patchMap = await patchIds(root, shas);
  const subjects = new Map();
  for (const output of readCommitBatches(root, ['log', '--format=%H%x00%s', '-z'], shas)) {
    const fields = output.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) subjects.set(fields[i], fields[i + 1].trim());
  }
  return shas.map(sha => {
    if (!subjects.has(sha)) throw new Error('git log did not return commit ' + sha);
    return { sha, patchId: patchMap.get(sha) || '', subject: subjects.get(sha) };
  });
}

export function changedPaths(root, shas) {
  const files = new Set();
  for (const output of readCommitBatches(root, ['show', '--format=', '--name-only', '-z'], shas)) {
    for (const p of output.split('\0')) {
      if (p && !p.startsWith('.bdd/')) files.add(p);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

// Keep native Git command lines below the Windows argument length limit.
function* batches(paths) {
  let batch = [], size = 0;
  for (const p of new Set(paths)) {
    if (size + p.length > 12000 && batch.length) { yield batch; batch = []; size = 0; }
    batch.push(p);
    size += p.length + 3;
  }
  if (batch.length) yield batch;
}

export function blobsAt(root, head, paths) {
  const blobs = Object.fromEntries(paths.map(p => [p, null]));
  for (const batch of batches(paths)) {
    for (const row of git(root, ['ls-tree', '-z', head, '--', ...batch]).split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t');
      blobs[row.slice(tab + 1)] = row.slice(0, tab).split(' ')[2];
    }
  }
  return blobs;
}

export function dirtyPaths(root, paths) {
  const dirty = new Set();
  for (const batch of batches(paths)) {
    const records = git(root, ['status', '--porcelain=v1', '-z', '--', ...batch]).split('\0').filter(Boolean);
    for (let i = 0; i < records.length; i++) {
      const line = records[i];
      const dest = line.slice(3);
      dirty.add(/[RC]/.test(line.slice(0, 2)) ? records[++i] + ' -> ' + dest : dest);
    }
  }
  return [...dirty];
}

export function isAncestor(root, source, head) {
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(source)) throw new Error('紀錄的 commit SHA 無效');
  if (git(root, ['cat-file', '-e', source + '^{commit}'], [0, 1, 128]) === null) return false;
  return git(root, ['merge-base', '--is-ancestor', source, head], [0, 1]) !== null;
}

export async function mapCommits(root, head, last, depth) {
  const mapping = [];
  let index;
  for (const entry of last.commits) {
    let status = 'same', target = entry.sha;
    if (!isAncestor(root, entry.sha, head)) {
      if (!index) {
        const paths = Object.keys(last.files);
        // Git reads pathspecs after a standalone "--" on stdin. POSIX names
        // containing a line break cannot be represented there; pass those as argv.
        const regular = paths.filter(p => !/[\r\n]/.test(p));
        const multiline = paths.filter(p => /[\r\n]/.test(p));
        const history = git(root, ['log', '--stdin', '--no-merges', '--format=%H%x00%s', '-z', '-n',
          String(depth), head, '--', ...multiline], [0], ['--', ...regular].join('\n') + '\n');
        const fields = history.split('\0');
        const shas = [], subjects = new Map(), patches = new Map();
        for (let i = 0; i + 1 < fields.length; i += 2) {
          shas.push(fields[i]);
          const subject = fields[i + 1].trim().toLowerCase();
          if (!subjects.has(subject)) subjects.set(subject, fields[i]);
        }
        const ids = await patchIds(root, shas);
        for (const sha of shas) {
          const id = ids.get(sha);
          if (id && !patches.has(id)) patches.set(id, sha);
        }
        index = { patches, subjects };
      }
      if (entry.patchId && index.patches.has(entry.patchId)) {
        status = 'patch'; target = index.patches.get(entry.patchId);
      } else if (index.subjects.has(entry.subject.toLowerCase())) {
        status = 'subject'; target = index.subjects.get(entry.subject.toLowerCase());
      } else { status = 'missing'; target = null; }
    }
    mapping.push({ source: entry.sha, target, status, subject: entry.subject });
  }
  return mapping;
}

export function testedCommits(root, references, base, head) {
  if (references.length) return references.map(ref => commit(root, ref));
  if (!base) throw new Error('記錄模式需要 --base 或 --commits');
  return git(root, ['rev-list', '--no-merges', '--reverse', base + '..' + head, '--']).trim().split(/\r?\n/).filter(Boolean);
}
