import path from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { commit, fullCommitId } from './git-changes.mjs';

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

function changedPaths(root, shas, rangeDiff = '') {
  const files = new Set(rangeDiff.split('\0'));
  const args = ['show', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=first-parent'];
  for (const output of readCommitBatches(root, args, shas)) {
    for (const p of output.split('\0')) files.add(p);
  }
  return [...files].filter(p => p && !p.startsWith('.bdd/')).sort((a, b) => a.localeCompare(b));
}

// Keep native Git command lines below the Windows argument length limit.
export function* pathspecBatches(paths) {
  let batch = [], size = 0;
  for (const p of new Set(paths)) {
    if (size + p.length > 12000 && batch.length) { yield batch; batch = []; size = 0; }
    batch.push(p);
    size += p.length + 3;
  }
  if (batch.length) yield batch;
}

export function treeEntriesAt(root, head, paths, { includeSizes = false } = {}) {
  const blobs = Object.fromEntries(paths.map(p => [p, null]));
  const modes = { ...blobs };
  const sizes = includeSizes ? { ...blobs } : null;
  for (const batch of pathspecBatches(paths)) {
    const args = ['ls-tree', includeSizes ? '-lz' : '-z', head, '--', ...batch];
    for (const row of git(root, args).split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t');
      const [mode, type, oid, size] = row.slice(0, tab).split(/\s+/);
      const name = row.slice(tab + 1);
      modes[name] = mode;
      blobs[name] = oid;
      if (sizes && type === 'blob') sizes[name] = Number(size);
    }
  }
  return includeSizes ? { blobs, modes, sizes } : { blobs, modes };
}

export function dirtyPaths(root, paths) {
  const dirty = new Set();
  for (const batch of pathspecBatches(paths)) {
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
  if (!fullCommitId.test(source)) throw new Error('紀錄的 commit SHA 無效');
  if (git(root, ['cat-file', '-e', source + '^{commit}'], [0, 1, 128]) === null) return false;
  return git(root, ['merge-base', '--is-ancestor', source, head], [0, 1]) !== null;
}

function reachableCommits(root, head, commits) {
  const reachable = new Set([head]);
  const requested = [...new Set(commits.map(entry => entry.sha))].filter(sha => sha !== head);
  if (!requested.length) return reachable;
  if (!requested.every(sha => typeof sha === 'string' && fullCommitId.test(sha))) throw new Error('紀錄的 commit SHA 無效');
  const objects = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], [0],
    requested.map(sha => sha + '^{commit}').join('\n') + '\n').trimEnd().split(/\r?\n/);
  const peeled = new Map();
  for (const [index, row] of objects.entries()) {
    const [oid, type] = row.split(' ');
    if (type === 'commit') peeled.set(requested[index], oid);
  }
  if (!peeled.size) return reachable;
  const tips = new Set(peeled.values());
  const limit = 32;
  // Outside HEAD, a short history gives an exact answer for every selected tip.
  // One extra entry signals truncation; only unclassified tips then need their own lookup.
  const history = git(root, ['rev-list', '--max-count=' + (limit + 1), '--stdin'], [0],
    ['^' + head, ...tips].join('\n') + '\n').trim();
  const outside = new Set(history ? history.split(/\r?\n/) : []);
  if (outside.size > limit) {
    for (const oid of tips) {
      if (oid !== head && !outside.has(oid) && git(root, ['merge-base', '--is-ancestor', oid, head], [0, 1]) === null) {
        outside.add(oid);
      }
    }
  }
  for (const [source, oid] of peeled) if (!outside.has(oid)) reachable.add(source);
  return reachable;
}

export async function mapCommits(root, head, last, depth) {
  const mapping = [];
  const reachable = reachableCommits(root, head, last.commits);
  let index;
  for (const entry of last.commits) {
    let status = 'same', target = entry.sha;
    if (!reachable.has(entry.sha)) {
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
        if (last.commits.some(c => c.patchId && !reachable.has(c.sha))) {
          const ids = await patchIds(root, shas);
          for (const sha of shas) {
            const id = ids.get(sha);
            if (id && !patches.has(id)) patches.set(id, sha);
          }
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

// Git treats shallow boundaries as roots and omits deletions from their missing parents.
function assertCompleteHistory(root, candidates) {
  if (!candidates.length || git(root, ['rev-parse', '--is-shallow-repository']).trim() !== 'true') return;
  const shallowFile = git(root, ['rev-parse', '--git-path', 'shallow']).trimEnd();
  const cutoffs = new Set(readFileSync(path.resolve(root, shallowFile), 'utf8').trim().split(/\r?\n/));
  if (candidates.some(sha => cutoffs.has(sha))) throw new Error('受測範圍的提交歷程不完整，請取得缺少的 Git 歷程');
}

export function selectedCommitPaths(root, shas) {
  if (!shas.every(sha => typeof sha === 'string' && fullCommitId.test(sha))) throw new Error('紀錄的 commit SHA 無效');
  assertCompleteHistory(root, shas);
  return changedPaths(root, shas);
}

function resolveCommitRefs(root, references) {
  if (references.length === 1) return [commit(root, references[0])];
  // Batch plain names, object IDs and parent selectors. Keep other revision
  // expressions under the original rev-parse --verify --end-of-options rules.
  const names = [...new Set(references.filter(ref =>
    /^[\p{L}\p{M}\p{N}_./-]+(?:[~^]\d*)*$/u.test(ref) && !ref.startsWith('-') && !ref.includes('..')))];
  const resolved = new Map();
  if (names.length) {
    const input = names.map(ref => ref + '^{commit}').join('\n') + '\n';
    const lines = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], [0], input).trimEnd().split('\n');
    if (lines.length !== names.length) throw new Error('git cat-file returned an incomplete list of revisions');
    for (const [i, line] of lines.entries()) {
      const [sha, type] = line.split(' ');
      if (type === 'commit' && fullCommitId.test(sha)) resolved.set(names[i], sha);
    }
  }
  // cat-file can exit successfully for a missing object. Re-run verify for
  // unresolved refs in input order so failures keep their original diagnostic.
  return references.map(ref => resolved.get(ref) ?? commit(root, ref));
}

export function testedChanges(root, references, base, head, { resolved = false } = {}) {
  if (references.length) {
    const shas = resolveCommitRefs(root, references);
    return { shas, paths: selectedCommitPaths(root, shas) };
  }
  if (!base) throw new Error('記錄模式需要 --base 或 --commits');
  if (resolved && base === head && fullCommitId.test(head)) return { shas: [], paths: [] };
  const history = git(root, ['rev-list', '--parents', '--reverse', base + '..' + head, '--']).trim()
    .split(/\r?\n/).filter(Boolean).map(line => line.split(' '));
  assertCompleteHistory(root, history.filter(row => row.length === 1).map(([sha]) => sha));
  // Keep patch/subject mapping limited to ordinary commits. Merge resolutions
  // still contribute paths, including edits subsequently reverted in the range.
  const shas = history.filter(row => row.length <= 2).map(row => row[0]);
  let rangeDiff = '';
  if (history.length !== shas.length) {
    const ancestor = git(root, ['merge-base', base, head], [0, 1])?.trim();
    // A merge can keep the first parent's tree and still differ from the
    // incoming baseline. Capture that net delta from their common ancestor.
    if (ancestor) rangeDiff = git(root, ['diff', '--no-renames', '--name-only', '-z', ancestor, head, '--']);
  }
  return { shas, paths: changedPaths(root, history.map(row => row[0]), rangeDiff) };
}
