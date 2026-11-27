import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readArchiveStates, withIndexLock } from './archive-index.mjs';
import { sequentialReadOptions } from './archive-limits.mjs';
import { git, hashStream } from './archive-pack.mjs';
import { outsideWorktrees, repository, resolveArchiveRoot } from './archive-store.mjs';
import { planArchiveInventory } from './extract.mjs';
import { pathspecBatches } from './verification-git.mjs';
import { openZip } from './zip-io.mjs';

const samePath = (a, b) => path.relative(a, b) === '';
const stat = file => fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
const sameIdentity = (a, b) => b && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameVersion = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function checkPhysical(file, entry) {
  if (entry?.isSymbolicLink() || !samePath(fs.realpathSync.native(file), file)) {
    throw new Error('含符號連結或 junction，不自動清理：' + file);
  }
}

function evidenceRoots(topic, entries = fs.readdirSync(topic)) {
  const pending = entries.find(name => /^\.bdd-(?:prune|extract|mask-stage)-|^masking\.json\.lock$/i.test(name));
  if (pending) throw new Error('上次作業留有暫存證據或作業仍在執行，請先確認：' + path.join(topic, pending));
  const roots = entries.filter(name => /^evidence(?:\.zip)?$/i.test(name));
  if (new Set(roots.map(n => n.toLowerCase())).size !== roots.length) throw new Error('證據目錄或檔名的大小寫不明確');
  return roots;
}

function snapshot(topic, roots) {
  const files = new Map(), dirs = new Map();
  const entries = fs.readdirSync(topic);
  const currentRoots = evidenceRoots(topic, entries);
  if (currentRoots.length !== roots.length || !roots.every(name => currentRoots.includes(name))) throw new Error('證據入口已變動');
  let bytes = 0;
  function walk(relative, evidence) {
    const full = path.join(topic, relative);
    const current = stat(full);
    if (!current || current.isSymbolicLink()) throw new Error('含符號連結或 junction，或證據已變動：' + full);
    if (current.isDirectory()) {
      if (evidence) dirs.set(relative, current);
      for (const child of fs.readdirSync(full)) walk(path.join(relative, child), evidence);
    } else if (evidence) {
      if (!current.isFile()) throw new Error('證據不是一般檔案：' + full);
      files.set(relative, current);
      bytes += Number(current.size);
    }
  }
  for (const root of roots) {
    const current = stat(path.join(topic, root));
    if (!(root.toLowerCase() === 'evidence' ? current?.isDirectory() : current?.isFile())) {
      throw new Error('證據入口類型異常或含符號連結或 junction：' + root);
    }
  }
  for (const name of entries) walk(name, roots.includes(name));
  return { files, dirs, bytes };
}

function evidencePaths(repo, topic, roots) {
  return roots.map(n => path.relative(repo, path.join(topic, n)).split(path.sep).join('/'));
}

function trackedFiles(repo, names) {
  return git(repo, ['--literal-pathspecs', 'ls-files', '-z', '--', ...names]);
}

function trackedPreflight(repo, topics) {
  const firstTracked = new Map();
  for (const batch of pathspecBatches(topics.flatMap(({ item, roots }) => evidencePaths(repo, item.path, roots)))) {
    const result = trackedFiles(repo, batch);
    if (result.status !== 0 || result.error) continue; // Retry per topic, including when combined output exceeds maxBuffer.
    const found = new Map(batch.map(name => [name, '']));
    for (const file of result.stdout.split('\0')) {
      if (!file) continue;
      // Each literal root is .bdd/<topic>/evidence or .bdd/<topic>/evidence.zip.
      const root = file.split('/', 3).join('/');
      if (!found.has(root)) { found.clear(); break; } // Let Git resolve unexpected path spellings per topic.
      if (!found.get(root)) found.set(root, file);
    }
    for (const [root, file] of found) firstTracked.set(root, file);
  }
  return firstTracked;
}

function checkTracked(repo, topic, roots, preflight) {
  const names = evidencePaths(repo, topic, roots);
  let first;
  if (preflight && names.every(name => preflight.has(name))) {
    first = names.map(name => preflight.get(name)).filter(Boolean).sort()[0];
  } else {
    const result = trackedFiles(repo, names);
    if (result.status !== 0 || result.error) throw new Error('不能確認證據的 git 追蹤狀態');
    first = result.stdout.split('\0', 1)[0];
  }
  if (first) throw new Error('證據檔已被 git 追蹤，不自動刪除：' + first);
}

async function sourceHashes(topic, files) {
  const hashes = [];
  for (const [name, version] of files) {
    const full = path.join(topic, name);
    checkPhysical(full);
    if (!sameVersion(version, stat(full))) throw new Error('證據已變動：' + full);
    if (name.toLowerCase() === 'evidence.zip') {
      const zip = await openZip(full);
      try {
        const inventory = await planArchiveInventory(zip.entries, path.parse(full).root, { evidenceZip: true });
        for (const item of inventory.files.values()) hashes.push(await hashStream(await item.entry.open()));
      } finally { await zip.close(); }
    } else hashes.push(await hashStream(fs.createReadStream(full, sequentialReadOptions(version.size))));
    if (!sameVersion(version, stat(full))) throw new Error('證據已變動：' + full);
  }
  return hashes;
}

async function archiveCoverage(state, worktrees) {
  const file = state.archive;
  if (!path.isAbsolute(file)) throw new Error('索引封存位置不是絕對路徑');
  await outsideWorktrees(file, worktrees);
  checkPhysical(file);
  const version = stat(file);
  if (!version?.isFile() || await hashStream(fs.createReadStream(file, sequentialReadOptions(version.size))) !== state.sha256.toUpperCase()) {
    throw new Error('封存 SHA-256 不符');
  }
  const zip = await openZip(file);
  const hashes = new Set();
  try {
    const { files, manifest } = await planArchiveInventory(zip.entries, path.parse(file).root);
    const importedFolder = state.legacy && state.recompressed && manifest?.legacy === true;
    if (!manifest?.files || (!importedFolder && !samePath(manifest.topic, state.topic))) {
      throw new Error('封存 manifest 主題或檔案清單不符');
    }
    for (const item of files.values()) {
      const hash = item.entry ? await hashStream(await item.entry.open()) : item.original.hash;
      item.hash = hash;
      if (!item.expectedHash) continue;
      if (hash !== item.expectedHash) throw new Error('封存內容與 manifest 的 SHA-256 不符');
      hashes.add(hash);
    }
    // A legacy import's own metadata cannot attest to bytes that were never in the ZIP.
    const verifiedOriginals = new Set(state.verifiedOriginalSha256 ?? []);
    for (const [name, record] of Object.entries(manifest.files)) {
      if (record.lossless !== true || record.encoder !== 'pillow' || !/^evidence\/.*\.webp$/is.test(name)) continue;
      if (typeof record.originalName !== 'string' || !/\.(png|jpe?g|bmp)$/i.test(record.originalName)) continue;
      if (record.originalName.replace(/\.[^.]+$/, '.webp') !== name || !/^[0-9a-f]{64}$/i.test(record.originalSha256)) continue;
      const original = record.originalSha256.toUpperCase();
      if (!state.legacy || verifiedOriginals.has(original)) hashes.add(original);
    }
  } finally { await zip.close(); }
  if (!sameVersion(version, stat(file))) throw new Error('封存檔已變動');
  return { state, version, hashes };
}

function checkSnapshot(before, current, roots, moved = false) {
  if (current.files.size !== before.files.size || current.dirs.size !== before.dirs.size) throw new Error('清理前證據清單已變動');
  for (const [name, version] of before.dirs) {
    if (!sameIdentity(version, current.dirs.get(name))) throw new Error('證據目錄已變動：' + name);
  }
  for (const [name, version] of before.files) {
    const after = current.files.get(name);
    // Moving a top-level ZIP may change its ctime, but not its identity, mtime or size.
    const unchanged = moved && roots.includes(name)
      ? sameIdentity(version, after) && after.size === version.size && after.mtimeNs === version.mtimeNs
      : sameVersion(version, after);
    if (!unchanged) throw new Error('證據檔已變動：' + name);
  }
}

function applyPrune(repo, topic, roots, before) {
  checkPhysical(topic, stat(topic));
  checkTracked(repo, topic, roots);
  const latest = evidenceRoots(topic);
  if (latest.length !== roots.length || latest.some(name => !roots.includes(name))) throw new Error('證據入口已變動');
  const stage = fs.mkdtempSync(path.join(topic, '.bdd-prune-'));
  const moved = [];
  let removed = 0;
  try {
    for (const name of roots) {
      const source = path.join(topic, name);
      const current = stat(source);
      const stable = before.dirs.has(name) ? sameIdentity(before.dirs.get(name), current) : sameVersion(before.files.get(name), current);
      if (!stable) throw new Error('清理前證據入口已變動：' + source);
      fs.renameSync(source, path.join(stage, name));
      moved.push(name);
    }
    const current = snapshot(stage, roots);
    checkSnapshot(before, current, roots, true);
    checkTracked(repo, topic, roots);
    // Only remove the exact verified files. A concurrently added file makes rmdir fail and is retained.
    for (const [name, version] of current.files) {
      const full = path.join(stage, name);
      checkPhysical(full);
      if (!sameVersion(version, stat(full))) throw new Error('清理前證據已變動：' + name);
      fs.unlinkSync(full);
      removed++;
    }
    for (const [name, version] of [...current.dirs].reverse()) {
      const full = path.join(stage, name);
      checkPhysical(full);
      if (!sameIdentity(version, stat(full))) throw new Error('清理前證據目錄已變動：' + name);
      fs.rmdirSync(full);
    }
    fs.rmdirSync(stage);
  } catch (error) {
    try {
      checkPhysical(stage);
      checkPhysical(topic, stat(topic));
      for (const name of moved.reverse()) {
        const saved = path.join(stage, name);
        if (!stat(saved)) continue;
        const original = path.join(topic, name);
        if (stat(original)) throw new Error('原路徑已重新使用：' + original);
        fs.renameSync(saved, original);
      }
      fs.rmdirSync(stage);
    } catch (recovery) {
      throw new PruneFailure(error.message + '；未移除的證據留在 ' + stage + '。' + recovery.message);
    }
    if (removed) throw new PruneFailure('清理中止；已清理 ' + removed + ' 個已封存的檔案，其餘已保留。' + error.message);
    throw error;
  }
}

class PruneFailure extends Error {}

function candidates(states, topic, main, accepted) {
  return states.filter(s => s.repo && path.isAbsolute(s.repo) && samePath(s.repo, main) &&
    typeof s.topic === 'string' && s.topic === path.basename(s.topic) && samePath(s.topic, topic) && accepted.includes(s.status) &&
    (accepted.includes('local-only') || s.attachments.some(a =>
      (typeof a === 'string' && a.trim() !== '') || (typeof a === 'number' && Number.isSafeInteger(a) && a > 0))));
}

function sameProof(previous, current) {
  if (!current || previous.sha256 !== current.sha256 || previous.legacy !== current.legacy) return false;
  const verified = new Set(current.verifiedOriginalSha256);
  return (previous.verifiedOriginalSha256 ?? []).every(hash => verified.has(hash));
}

async function assess(item, roots, context, preflight) {
  const { repo, worktrees, states, accepted } = context;
  checkPhysical(item.path, stat(item.path));
  const before = snapshot(item.path, roots);
  item.bytes = before.bytes;
  checkTracked(repo, item.path, roots, preflight);
  const matches = candidates(states, item.topic, worktrees[0], accepted);
  if (!matches.length) throw new Error('沒有符合 ' + accepted.join('／') + ' 清理條件的同 repo 同主題封存');
  const covered = [], known = new Set();
  for (const state of matches) {
    try {
      const proof = await archiveCoverage(state, worktrees);
      for (const hash of proof.hashes) known.add(hash);
      covered.push({ state, version: proof.version });
    } catch { /* Other verified archives for this topic may still cover the evidence. */ }
  }
  if (!covered.length) throw new Error('同主題封存檔不存在、SHA-256 不符或沒有可驗證的 manifest');
  item.coveredBy = covered.map(c => c.state.archive);
  const missing = (await sourceHashes(item.path, before.files)).filter(hash => !known.has(hash));
  if (missing.length) throw new Error('有 ' + missing.length + ' 個證據檔的內容不在已核對的封存裡');
  item.action = 'prune';
  item.reason = accepted.length > 1 ? '證據內容全部收在本機封存庫的封存中' : '證據內容全部收在已上傳並確認的封存中';
  return { item, roots, before, covered };
}

const maxBatchTopics = 4;

function applyVerifiedTopic({ item, roots, before, covered }, states, { repo, worktrees, accepted }) {
  const latest = candidates(states, item.topic, worktrees[0], accepted);
  for (const { state, version } of covered) {
    if (!sameProof(state, latest.find(s => samePath(s.archive, state.archive))) ||
        !sameVersion(version, stat(state.archive))) throw new Error('封存檔或索引狀態已變動，請重試');
    checkPhysical(state.archive);
  }
  applyPrune(repo, item.path, roots, before);
  item.action = 'pruned';
}

function keepItem(item, error) {
  if (error instanceof PruneFailure) throw error;
  item.action = 'keep';
  item.reason = error.message;
}

function indexUnchanged(index, version) {
  try { return version && sameVersion(version, stat(index)); }
  catch { return false; } // Reacquire and replay before attempting another topic.
}

async function applyBatch(pending, context) {
  const { index } = context;
  let next = 0;
  while (next < pending.length) {
    const first = next;
    try {
      await withIndexLock(index, async () => {
        const version = stat(index);
        const latest = await readArchiveStates(index, { includeVerifiedOriginals: true });
        if (!indexUnchanged(index, version)) throw new Error('封存索引已變動，請重試');
        const deadline = performance.now() + 1000;
        do {
          const plan = pending[next++];
          try { applyVerifiedTopic(plan, latest, context); }
          catch (error) { keepItem(plan.item, error); }
          // Writers using the index lock cannot invalidate this read. Yield between
          // topics after a slow deletion or if the index was edited outside the lock.
        } while (next < pending.length && performance.now() < deadline && indexUnchanged(index, version));
      });
    } catch (error) {
      if (next !== first) throw error; // Partial deletion or lock release failure: stop with its original error.
      keepItem(pending[next++].item, error);
    }
  }
  pending.length = 0;
}

export async function pruneCommand(args) {
  const { values } = parseArgs({ args, options: {
    repo: { type: 'string' }, 'archive-root': { type: 'string' }, apply: { type: 'boolean' }, 'allow-local-only': { type: 'boolean' },
    topic: { type: 'string', multiple: true },
  } });
  if (!values.repo) throw new Error('請以 --repo 指定工作區');
  if (values.topic?.length > 1) throw new Error('--topic 只能指定一個主題目錄');
  const topicName = values.topic?.[0];
  const { repo, worktrees } = repository(path.resolve(values.repo));
  const bdd = path.join(repo, '.bdd');
  const applied = Boolean(values.apply);
  const summary = { repo, applied, items: [] };
  const tree = stat(bdd);
  if (!tree && topicName !== undefined) throw new Error('找不到 .bdd 目錄，無法選取 --topic：' + topicName);
  if (tree) {
    if (!tree.isDirectory()) throw new Error('.bdd 不是一般目錄：' + bdd);
    checkPhysical(bdd);
    const directories = fs.readdirSync(bdd, { withFileTypes: true }).filter(dir =>
      (dir.isDirectory() || dir.isSymbolicLink()) && dir.name.toLowerCase() !== 'modules' &&
      (topicName === undefined || dir.name === topicName));
    if (topicName !== undefined && !directories.length) throw new Error('找不到 --topic 指定的 .bdd 主題目錄：' + topicName);
    const { root } = resolveArchiveRoot({ archiveRoot: values['archive-root'], outputDir: path.join(bdd, '_'), worktrees });
    const index = path.join(root, 'index.jsonl');
    await outsideWorktrees(root, worktrees);
    const states = await readArchiveStates(index, { includeVerifiedOriginals: true });
    const accepted = values['allow-local-only'] ? ['uploaded-verified', 'uploaded', 'local-only'] : ['uploaded-verified'];
    const context = { repo, worktrees, states, index, accepted };
    const topics = [], pending = [];
    summary.archiveRoot = root;
    summary.prunableBytes = 0;
    for (const dir of directories) {
      const topic = path.join(bdd, dir.name);
      const item = { topic: dir.name, path: topic, bytes: 0, action: 'keep', reason: '', coveredBy: [] };
      try {
        checkPhysical(topic, dir);
        const roots = evidenceRoots(topic);
        if (!roots.length) continue;
        topics.push({ item, roots });
      } catch (error) {
        keepItem(item, error);
      }
      summary.items.push(item);
    }
    const preflight = trackedPreflight(repo, topics);
    for (const { item, roots } of topics) {
      try {
        const plan = await assess(item, roots, context, preflight);
        if (applied) pending.push(plan);
      } catch (error) {
        keepItem(item, error);
      }
      if (pending.length === maxBatchTopics) await applyBatch(pending, context);
    }
    await applyBatch(pending, context);
    for (const item of summary.items) if (item.action !== 'keep') summary.prunableBytes += item.bytes;
  }
  console.log(JSON.stringify(summary));
  return 0;
}
