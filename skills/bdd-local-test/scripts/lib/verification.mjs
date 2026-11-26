import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { captureApprovedRevision } from './approved-revision.mjs';
import { commit, repoRoot } from './git-changes.mjs';
import { readFeature } from './module-index.mjs';
import { git, repoIdentity, blobsAt, dirtyPaths, testedChanges, commitInfo, mapCommits, isAncestor } from './verification-git.mjs';

function readDocument(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!Array.isArray(doc?.rounds)) throw new Error('verification.json 的 rounds 必須是陣列');
  return doc;
}

// Cooperating writers append under the same lock. Rename publishes the complete
// JSON in one filesystem operation, so readers see either the old or new rounds.
async function appendRound(file, round) {
  const lock = file + '.lock';
  const deadline = Date.now() + 10000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('驗證紀錄鎖定中。若寫入程序仍在執行，請等待後重試。若程序已終止，先備份並檢查此鎖檔的未發布紀錄，再移走鎖檔重試：' + lock);
      await delay(40);
    }
  }
  let published = false;
  try {
    const doc = readDocument(file) ?? { rounds: [] };
    doc.rounds.push(round);
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(lock, file);
    published = true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!published) fs.unlinkSync(lock);
  }
}

function recordedAt(now) {
  const pad = n => String(n).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const zone = (offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
  const day = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('-');
  return day + ' ' + [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join(':') + ' ' + zone;
}

function scenarioRecords(root, entries, role) {
  return (entries || []).flatMap(v => v.split(';')).map(s => s.trim()).filter(Boolean).map(entry => {
    const separator = entry.indexOf('::');
    const rel = (separator === -1 ? entry : entry.slice(0, separator)).replaceAll('\\', '/').replace(/^\.\//, '');
    if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.split('/').includes('..')) {
      throw new Error('情境檔必須使用 repo 相對路徑：' + rel);
    }
    const file = path.join(root, rel);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('找不到情境檔：' + rel);
    const ids = separator === -1 ? readFeature(file, root).scenarios.flatMap(s => s.ids)
      : entry.slice(separator + 2).split(/[,\s]+/).filter(Boolean);
    return { path: rel, blob: null, ids, role };
  });
}

function intOption(value, name) {
  if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--' + name + ' 必須為整數');
  return Number(value);
}

async function record(file, opts) {
  const result = Object.fromEntries(['passed', 'failed', 'blocked', 'not-run'].map(name =>
    [name === 'not-run' ? 'notRun' : name, intOption(opts[name] ?? '0', name)]));
  const root = repoRoot('.');
  const head = commit(root, opts.head ?? 'HEAD');
  const revision = opts['capture-revision'] ? captureApprovedRevision(root) : null;
  if (revision && revision.head !== head) throw new Error('記錄受測快照時，指定的 HEAD 須與實際 checkout 相同');
  const base = opts.base ? commit(root, opts.base) : null;
  const refs = (opts.commits || []).flatMap(s => s.split(/[,\s]+/)).filter(Boolean);
  const { shas, paths } = testedChanges(root, refs, base, head);
  const scenarios = [
    ...scenarioRecords(root, opts['changed-scenarios'], 'changed'),
    ...scenarioRecords(root, opts['regression-scenarios'], 'regression'),
  ];
  const allPaths = [...paths, ...scenarios.map(s => s.path)];
  const blobs = blobsAt(root, head, allPaths);
  for (const s of scenarios) s.blob = blobs[s.path];
  const round = {
    recordedAt: recordedAt(new Date()), repo: repoIdentity(root), branch: git(root, ['branch', '--show-current']).trim(),
    head, base, baseRef: opts.base || '', dirtyPaths: dirtyPaths(root, allPaths), commits: await commitInfo(root, shas),
    fileScope: refs.length ? 'commits' : 'base',
    files: Object.fromEntries(paths.map(p => [p, blobs[p]])), scenarios, result, note: opts.note || '',
  };
  if (revision) round.revision = revision;
  await appendRound(file, round);
  return round;
}

const normalizedUrl = url => url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');

function checkedFiles(root, last, sameRepo, reasons) {
  if (last.fileScope || !last.base || !sameRepo) return last.files;
  // Older records also kept a base when explicit commits overrode --base.
  // Reconstruct range coverage only if its commits match the recorded selection.
  try {
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(last.base)) throw new Error('基準 SHA 無效');
    const { shas, paths } = testedChanges(root, [], last.base, last.head);
    const selected = new Set(last.commits.map(c => c.sha));
    if (selected.size !== shas.length || !shas.every(sha => selected.has(sha))) return last.files;
    const omitted = paths.filter(p => !Object.hasOwn(last.files, p));
    if (!omitted.length) return last.files;
    // Committed blobs are recoverable. The omitted paths' working-tree state
    // at test time was never captured, even if their committed blobs still match.
    reasons.push('舊驗證紀錄未涵蓋以下受測路徑，無法確認實測當時的工作區狀態：' + omitted.join('、'));
    return { ...last.files, ...blobsAt(root, last.head, omitted) };
  } catch (error) {
    reasons.push('無法重建舊驗證紀錄的受測範圍：' + error.message);
    return last.files;
  }
}

async function check(last, depth) {
  if (!last?.repo || typeof last.repo.url !== 'string' || !Array.isArray(last.commits) ||
      !last.files || typeof last.files !== 'object' || Array.isArray(last.files) ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(last.head)) throw new Error('verification.json 缺少有效的版本紀錄');
  const root = repoRoot('.');
  const repo = repoIdentity(root);
  const head = commit(root, 'HEAD');
  const reasons = [];
  const sameUrl = normalizedUrl(repo.url) === normalizedUrl(last.repo.url);
  const sameRepo = sameUrl && (repo.url || last.repo.name === repo.name);
  if (!sameRepo) reasons.push('repo 不同：紀錄於 ' + last.repo.name + '（' + last.repo.url + '），目前為 ' + repo.name + '（' + repo.url + '）');
  if (head !== last.head && !isAncestor(root, last.head, head)) reasons.push('目前 HEAD 並非由受測版本前進');
  const mapping = await mapCommits(root, head, last, depth);
  const cherry = mapping.filter(m => m.status === 'patch');
  const rewritten = mapping.filter(m => m.status === 'subject');
  const missing = mapping.filter(m => m.status === 'missing');
  if (cherry.length) reasons.push(cherry.length + ' 個受測 commit 以 cherry-pick 形式存在（SHA 不同、內容相同）');
  if (rewritten.length) reasons.push(rewritten.length + ' 個受測 commit 只找到同標題的 commit，內容有差異：' + rewritten.map(m => m.subject).join('；'));
  if (missing.length) reasons.push(missing.length + ' 個受測 commit 在目前 repo 找不到：' + missing.map(m => m.subject).join('；'));
  const scenarios = last.scenarios ?? [];
  const recordedFiles = checkedFiles(root, last, sameRepo, reasons);
  const files = Object.keys(recordedFiles);
  const paths = [...files, ...scenarios.map(s => s.path)];
  const blobs = blobsAt(root, head, paths);
  const changedFiles = files.filter(p => recordedFiles[p] !== blobs[p]);
  const changedScenarios = scenarios.filter(s => !s.blob || s.blob !== blobs[s.path]).map(s => s.path);
  const dirty = dirtyPaths(root, paths);
  if (changedScenarios.length) reasons.push(changedScenarios.length + ' 個情境檔與受測時不同或受測時未提交：' + changedScenarios.join('、'));
  if (changedFiles.length) reasons.push(changedFiles.length + ' 個受測檔案內容與受測時不同');
  if (dirty.length) reasons.push(dirty.length + ' 個受測檔案有未提交異動');
  if (last.dirtyPaths?.length) reasons.push('記錄時有未提交異動：' + last.dirtyPaths.join('、'));
  else if (last.revision?.dirtySha256) reasons.push('實測快照包含未提交內容，無法從 commit 確認相同的受測版本');
  return {
    verdict: reasons.length ? 'rerun' : head === last.head ? 'current' : 'still-valid', reasons,
    recorded: { repo: last.repo, branch: last.branch, head: last.head, recordedAt: last.recordedAt, result: last.result },
    current: { repo, branch: git(root, ['branch', '--show-current']).trim(), head },
    commits: mapping, changedFiles, changedScenarios, dirtyPaths: dirty,
  };
}

export async function verificationCommand(args) {
  const str = { type: 'string' };
  const list = { type: 'string', multiple: true };
  const flag = { type: 'boolean' };
  const { values: v } = parseArgs({ args, options: {
    dir: str, record: flag, check: flag, 'capture-revision': flag, base: str, commits: list, head: str, passed: str, failed: str,
    blocked: str, 'not-run': str, note: str, 'changed-scenarios': list, 'regression-scenarios': list, 'search-depth': str,
  } });
  if (!v.dir || Boolean(v.record) === Boolean(v.check)) throw new Error('請指定 --dir，並擇一指定 --record 或 --check');
  if (v['capture-revision'] && !v.record) throw new Error('--capture-revision 適用於 --record');
  const file = path.join(v.dir, 'verification.json');
  if (v.record) {
    console.log(JSON.stringify(await record(file, v)));
    return 0;
  }
  const doc = readDocument(file);
  if (!doc) {
    console.log(JSON.stringify({ verdict: 'no-record', reasons: ['找不到 ' + file + '，視為從未記錄，須重新驗證'] }));
    return 2;
  }
  const depth = intOption(v['search-depth'] ?? '3000', 'search-depth');
  const result = await check(doc.rounds.at(-1), depth);
  console.log(JSON.stringify(result));
  return result.verdict === 'rerun' ? 1 : 0;
}
