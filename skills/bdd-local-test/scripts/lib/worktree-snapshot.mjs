import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatus } from './approved-revision.mjs';
import { git, repoIdentity } from './verification-git.mjs';

const splitPaths = output => output.split('\0').filter(Boolean);
const changed = () => new Error('工作樹在快照擷取期間變更，請重試');
const oid = /^(?:[a-f\d]{40}|[a-f\d]{64})$/;
function recordPaths(dir) {
  if (dir === null) return [];
  const record = path.posix.join(dir, 'verification.json');
  return [record, record + '.lock'];
}

function isOutput(name, records) {
  if (process.platform === 'win32') {
    name = name.toLowerCase();
    if (records.some(p => p.toLowerCase() === name)) return true;
  } else if (records.includes(name)) return true;
  return name.startsWith('.bdd/') && name !== '.bdd/config.json' &&
    !(name.startsWith('.bdd/modules/') && /\/(?:[^/]+\.feature|module\.md)$/i.test(name));
}

function productStatus(repo, head, records) {
  const status = readStatus(repo);
  if (status.head !== head) throw changed();
  const files = new Map(), removed = new Set(), additions = [], trackedOutputs = [];
  for (const row of status.entries) {
    const tracked = /^1 \S+ (\S+) (\d+) (\d+) (\d+) [\da-f]+ ([\da-f]+) ([\s\S]+)$/.exec(row);
    if (!tracked && !row.startsWith('? ')) throw new Error('請先解決工作樹的合併衝突再保存快照');
    const name = tracked ? tracked[6] : row.slice(2);
    if (isOutput(name, records)) {
      if (tracked) trackedOutputs.push(name);
      continue;
    }
    if (tracked && tracked[4] === '000000') {
      removed.add(name);
      continue;
    }
    const submodule = tracked?.[4] === '160000';
    if (name.endsWith('/') || (submodule && /[MU]/.test(tracked[1]))) {
      throw new Error('工作樹含有未提交的巢狀 repo 或子模組內容，請先在該 repo 保存受測版本：' + name);
    }
    const file = path.join(repo, name);
    const parent = path.dirname(file);
    if (path.relative(parent, fs.realpathSync.native(parent))) throw changed();
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() && !stat.isSymbolicLink() && !(stat.isDirectory() && submodule)) {
      throw new Error('無法保存工作樹中的特殊檔案：' + name);
    }
    if (tracked?.[2] === '000000' && tracked[3] !== '000000') {
      // Teach the private index about staged additions, including explicitly tracked ignored names.
      additions.push(tracked[3] + ' ' + tracked[5] + '\t' + name);
    }
    const nestedHead = submodule ? git(file, ['rev-parse', 'HEAD']).trim() : '';
    files.set(name, [row, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, nestedHead].join('\0'));
  }
  return { files, removed, additions, trackedOutputs };
}

// Build from HEAD with a private index. Only paths visible to Git in the tested
// worktree are staged, and BDD outputs are removed even when previously tracked.
function worktreeTree(root, head, dir) {
  const repo = fs.realpathSync.native(root);
  const records = recordPaths(dir);
  // status intentionally hides these paths. A clean tree shortcut could otherwise
  // certify stale contents (including paths missing from a sparse checkout).
  const exclusions = new Set();
  for (const row of splitPaths(git(repo, ['ls-files', '-v', '-z']))) {
    const name = row.slice(2);
    if (isOutput(name, records)) exclusions.add(name);
    else if (/^[a-zS] /.test(row)) throw new Error('工作樹含有 assume-unchanged 或 skip-worktree 路徑，無法完整保存受測內容：' + name);
  }
  const { files, removed, additions, trackedOutputs } = productStatus(repo, head, records);
  // Also exclude HEAD outputs that a staged deletion has removed from the real index.
  for (const name of trackedOutputs) exclusions.add(name);
  let tree;
  if (!files.size && !removed.size && !exclusions.size) {
    tree = git(repo, ['rev-parse', head + '^{tree}']).trim();
  } else {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-worktree-index-'));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') };
    const index = (args, paths) => execFileSync('git', [
      '-C', repo, '--literal-pathspecs', '-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=' + temporary, ...args,
    ], { env, input: paths ? [...paths].join('\0') + '\0' : undefined,
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    try {
      index(['read-tree', head]);
      const drop = new Set([...removed, ...exclusions]);
      if (drop.size) index(['update-index', '--force-remove', '-z', '--stdin'], drop);
      if (additions.length) index(['update-index', '-z', '--index-info'], additions);
      if (files.size) index(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], files.keys());
      tree = index(['write-tree']).trim();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  const after = productStatus(repo, head, records);
  if (files.size !== after.files.size || removed.size !== after.removed.size ||
      [...files].some(([name, value]) => after.files.get(name) !== value) ||
      [...removed].some(name => !after.removed.has(name))) throw changed();
  return tree;
}

function snapshotRef({ head, tree, outputDir, issue }) {
  const key = createHash('sha256').update(JSON.stringify([head, tree, outputDir, issue])).digest('hex');
  return 'refs/bdd/worktree-snapshots/' + key + '/tree';
}

function issueFromPath(file) {
  return file.split(/[\\/]/).join('/').match(/(?:^|\/)\.bdd\/(\d+)(?=[/-]|$)/)?.[1] ?? null;
}

export function captureWorktreeSnapshot(repo, head, file, explicitIssue) {
  const relative = path.relative(fs.realpathSync.native(repo), fs.realpathSync.native(path.dirname(file))).split(path.sep).join('/');
  const outputDir = relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? null : relative;
  const inferred = issueFromPath(path.resolve(file));
  if (explicitIssue && inferred && explicitIssue !== inferred) throw new Error('受測單號與輸出目錄的單號不同');
  const snapshot = { head, tree: worktreeTree(repo, head, outputDir), outputDir, issue: explicitIssue ?? inferred };
  snapshot.ref = snapshotRef(snapshot);
  return snapshot;
}

const headRefOf = snapshot => snapshot.ref.replace(/\/tree$/, '/head');

export function pinWorktreeSnapshot(repo, snapshot) {
  // Pin the tested checkout as well as the product tree in the same transaction.
  // The next round can still record its baseHead after a detached checkout and GC.
  git(repo, ['update-ref', '--stdin'], [0], 'update ' + snapshot.ref + ' ' + snapshot.tree +
    '\nupdate ' + headRefOf(snapshot) + ' ' + snapshot.head + '\n');
}

export function previousWorktreeChanges(repo, head, file, issue) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const round = Array.isArray(doc?.rounds) && doc.rounds.at(-1);
  const snapshot = round?.worktreeSnapshot;
  if (!snapshot || !oid.test(snapshot.tree) || !oid.test(snapshot.head) || snapshot.head !== round.head ||
      (snapshot.outputDir !== null && typeof snapshot.outputDir !== 'string') ||
      !(snapshot.issue === null || typeof snapshot.issue === 'string' && /^\d+$/.test(snapshot.issue)) ||
      snapshot.ref !== snapshotRef(snapshot)) throw new Error('上一輪缺少有效的工作樹快照，請提供可核對的 --base');
  if ((snapshot.issue && snapshot.issue !== issue) || (issueFromPath(file) && issueFromPath(file) !== issue)) {
    throw new Error('上一輪驗證紀錄與本批單號不同');
  }
  const remote = repoIdentity(repo).url;
  const normalize = url => url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  const pinnedRefs = ['show-ref', '--verify', '--hash', snapshot.ref, headRefOf(snapshot)];
  if (typeof round.repo?.url !== 'string' || normalize(remote) !== normalize(round.repo.url) ||
      git(repo, pinnedRefs, [0, 1, 128])?.trimEnd().replace(/\r\n/g, '\n') !== snapshot.tree + '\n' + snapshot.head) {
    throw new Error('所在 Git 儲存庫找不到上一輪登記的工作樹快照');
  }
  const tree = worktreeTree(repo, head, snapshot.outputDir);
  const paths = splitPaths(git(repo, ['diff', '--no-renames', '--name-only', '-z', snapshot.tree, tree, '--']));
  return { base: snapshot.tree, baseHead: snapshot.head, paths: paths.sort((a, b) => a.localeCompare(b)) };
}
