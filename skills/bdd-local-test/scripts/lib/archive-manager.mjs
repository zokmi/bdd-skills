import { constants, createReadStream } from 'node:fs';
import { access, copyFile, link, lstat, mkdir, mkdtemp, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { appendIndexEvents, findArchiveIndexRoot, readArchiveStates, withIndexLock } from './archive-index.mjs';
import { safePathComponent } from './archive-limits.mjs';
import { hashStream } from './archive-pack.mjs';
import { outsideWorktrees, repository, resolveArchiveRoot } from './archive-store.mjs';

async function indexRoot(opts, repoInfo) {
  if (opts['archive-root']) return opts['archive-root'];
  if (opts.archive && !opts.import) {
    try { return await findArchiveIndexRoot(opts.archive); }
    catch (error) { if (!opts.repo || error.code !== 'ENOENT') throw error; }
  }
  if (!opts.repo) throw new Error('找不到封存索引，請指定 --archive-root、--archive 或 --repo');
  const { repo, worktrees } = repoInfo ?? repository(opts.repo);
  return resolveArchiveRoot({ outputDir: path.join(repo, '.bdd', '_'), worktrees }).root;
}

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

async function listArchives(index, opts) {
  const matches = (value, filter) => !filter || String(value ?? '').toLowerCase() === filter.toLowerCase();
  const archives = (await readArchiveStates(index)).filter(s => matches(s.issue, opts.issue) && matches(s.topic, opts.topic));
  for (let start = 0; start < archives.length; start += 32) {
    const batch = archives.slice(start, start + 32);
    await Promise.all(batch.map(async state => { state.exists = await exists(state.archive); }));
  }
  return { count: archives.length, archives };
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function checkedHash(file) {
  const before = await lstat(file);
  if (!before.isFile()) throw new Error(`不是一般封存檔：${file}`);
  const sha256 = await hashStream(createReadStream(file));
  const after = await lstat(file);
  if (!sameFile(before, after) || before.ctimeMs !== after.ctimeMs) throw new Error(`封存檔在核對期間變動：${file}`);
  return { sha256, stat: after };
}

async function markArchive(index, opts) {
  if (!opts.archive || !opts.status) throw new Error('--mark 需要 --archive 與 --status');
  const status = opts.status.toLowerCase();
  if (!['local-only', 'uploaded', 'uploaded-verified', 'superseded'].includes(status)) throw new Error('不支援的封存狀態：' + opts.status);
  const attachments = (opts.attachment ?? []).flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean);
  if (status.startsWith('uploaded') && !attachments.length) throw new Error(status + ' 必須以 --attachment 指定 issue 附件 ID 或網址');
  const archive = opts.archive;
  if (!(await exists(index))) throw new Error(`索引裡沒有這個封存檔：${archive}`);
  return withIndexLock(index, async stat => {
    const [state] = await readArchiveStates(index, { archive });
    if (!state) throw new Error(`索引裡沒有這個封存檔：${archive}`);
    const { sha256 } = await checkedHash(archive);
    if (sha256 !== String(state.sha256).toUpperCase()) throw new Error(`封存檔 SHA-256 與建立時不同（建立 ${state.sha256}、目前 ${sha256}），拒絕登記`);
    await appendIndexEvents(index, stat, [{ event: 'status', archive: state.archive, status, attachments,
      note: opts.note ?? '', at: new Date().toISOString() }]);
    return { archive: state.archive, previousStatus: state.status, status, attachments, sha256 };
  });
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function legacyDirectory(root, issue) {
  await mkdir(root, { recursive: true });
  let dir = root;
  for (const name of [issue, 'legacy']) {
    dir = path.join(dir, name);
    try { await mkdir(dir); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(dir)).isDirectory()) throw new Error('匯入位置不是獨立目錄：' + dir);
  }
  return dir;
}

async function linkOrCopy(source, destination) {
  try { await link(source, destination); return true; }
  catch (error) {
    if (!['EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    return false;
  }
}

// Capture the named source before deleting it. A replacement or an edit during
// import must survive, even if a different writer recreates the original path.
async function removeImportedSource(source, verified, target, warnings) {
  let dir, held;
  let captured = false;
  try {
    dir = await mkdtemp(path.join(path.dirname(source), '.bdd-import-move-'));
    held = path.join(dir, path.basename(source));
    await rename(source, held);
    captured = true;
    const actual = await checkedHash(held);
    if (!sameFile(actual.stat, verified.stat) || actual.sha256 !== verified.sha256) throw new Error('來源在匯入期間變動');
    if ((await checkedHash(target)).sha256 !== verified.sha256) throw new Error('封存副本在匯入期間變動');
    await unlink(held);
    captured = false;
    return true;
  } catch (error) {
    warnings.push(`已登記封存並保留來源：${error.message}`);
    if (captured) {
      try {
        await linkOrCopy(held, source);
        await unlink(held);
        captured = false;
      } catch { warnings.push('保留待復原的來源：' + held); }
    }
    return false;
  } finally {
    if (dir && !captured) await rmdir(dir);
  }
}

async function importArchive(root, index, opts, repoInfo) {
  if (!opts.archive || !opts.issue || !opts.topic) throw new Error('--import 需要 --archive、--issue 與 --topic');
  const issue = safePathComponent(opts.issue);
  const source = opts.archive;
  const name = safePathComponent(path.basename(source));
  const warnings = [];
  const target = path.join(root, issue, 'legacy', name);
  if (repoInfo) {
    await outsideWorktrees(root, repoInfo.worktrees, warnings);
    await outsideWorktrees(target, repoInfo.worktrees, warnings);
  }
  if (within(root, source)) throw new Error('來源已在封存庫內，不需要匯入：' + source);
  const verified = await checkedHash(source);
  const dir = await legacyDirectory(root, issue);
  if (within(await realpath(root), await realpath(source))) throw new Error('來源已在封存庫內，不需要匯入：' + source);
  const stageDir = await mkdtemp(path.join(dir, '.bdd-import-'));
  const staged = path.join(stageDir, 'archive');
  let movedSource = false;
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    const stagedHash = await checkedHash(staged);
    if (stagedHash.sha256 !== verified.sha256) throw new Error('複製後 SHA-256 不符，保留來源：' + source);
    await withIndexLock(index, async stat => {
      const [state] = await readArchiveStates(index, { archive: target });
      if (state) throw new Error('索引已有這個封存檔：' + target);
      let published;
      try {
        let linked = false;
        try {
          linked = await linkOrCopy(staged, target);
          published = linked ? stagedHash.stat : await lstat(target);
        }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const saved = linked && sameFile(stagedHash.stat, await lstat(target)) ? stagedHash : await checkedHash(target);
        if (saved.sha256 !== verified.sha256) throw new Error('封存庫已有同名但內容不同的檔案：' + target);
        await appendIndexEvents(index, stat, [{ event: 'created', archive: target, name, issue, topic: opts.topic,
          commit: opts.commit ?? '', sha256: saved.sha256, bytes: saved.stat.size, repo: repoInfo?.worktrees[0] ?? null,
          sourceDir: null, legacy: true, importedFrom: source, note: opts.note ?? '', at: new Date().toISOString() }]);
      } catch (error) {
        if (published && await exists(target) && sameFile(published, await lstat(target))) await unlink(target);
        throw error;
      }
      if (opts.move) movedSource = await removeImportedSource(source, verified, target, warnings);
    });
  } finally {
    await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(stageDir);
  }
  return { archive: target, sha256: verified.sha256, movedSource, warnings };
}

export async function archiveIndexCommand(args) {
  const flag = { type: 'boolean' }, string = { type: 'string' };
  const { values: opts } = parseArgs({ args, options: {
    list: flag, mark: flag, import: flag, move: flag, commit: string, archive: string, status: string,
    attachment: { ...string, multiple: true }, note: string, 'archive-root': string, repo: string, issue: string, topic: string,
  } });
  if ([opts.list, opts.mark, opts.import].filter(Boolean).length !== 1) throw new Error('請擇一指定 --list、--mark 或 --import');
  for (const key of ['repo', 'archive', 'archive-root']) {
    if (opts[key]) opts[key] = path.resolve(opts[key].replace(/^~(?=[\\/]|$)/, () => os.homedir()));
  }
  const repoInfo = opts.import && opts.repo ? repository(opts.repo) : undefined;
  const root = await indexRoot(opts, repoInfo);
  const index = path.join(root, 'index.jsonl');
  let result;
  if (opts.list) result = await listArchives(index, opts);
  else if (opts.mark) result = await markArchive(index, opts);
  else result = await importArchive(root, index, opts, repoInfo);
  console.log(JSON.stringify({ archiveRoot: root, ...result }));
  return 0;
}
