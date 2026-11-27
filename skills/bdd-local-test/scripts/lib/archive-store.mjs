import { constants, createReadStream, statSync } from 'node:fs';
import { copyFile, link, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { appendIndexEvents, previousArchives, withIndexLock } from './archive-index.mjs';
import { git, hashBytes, hashStream } from './archive-pack.mjs';
import { byteLimit, entryLimit, manifestLimit, safePathComponent, sequentialReadOptions } from './archive-limits.mjs';
import { loadBddOutputConfig } from './bdd-output-config.mjs';

async function statIfPresent(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export function repository(source) {
  let dir = path.resolve(source);
  while (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`找不到存在的上層目錄：${source}`);
    dir = parent;
  }
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new Error(`不在 git 工作區內：${source}`);
  const list = git(dir, ['worktree', 'list', '--porcelain', '-z']);
  const worktrees = list.stdout?.split('\0').filter(s => s.startsWith('worktree ')).map(s => path.resolve(s.slice(9)));
  if (list.status !== 0 || !worktrees.length) throw new Error(`無法取得 worktree 清單：${source}`);
  return { repo: path.resolve(top.stdout.trimEnd()), worktrees };
}

export async function outsideWorktrees(target, worktrees, warnings) {
  let ancestor = target;
  while (!(await statIfPresent(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`找不到存在的上層目錄：${target}`);
    ancestor = parent;
  }
  const physical = path.resolve(await realpath(ancestor), path.relative(ancestor, target));
  for (const tree of worktrees) {
    const ref = await statIfPresent(tree) ? await realpath(tree) : tree;
    const testPaths = [path.relative(ref, physical), path.relative(tree, target)];
    if (testPaths.some(rel => rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) {
      throw new Error(`封存位置不可在受測 repo 的 worktree 內（${tree}）：${target}`);
    }
  }
  const probe = (await lstat(ancestor)).isDirectory() ? ancestor : path.dirname(ancestor);
  const other = git(probe, ['rev-parse', '--show-toplevel']);
  if (other.status === 0 && git(probe, ['check-ignore', '-q', '--', physical]).status !== 0) {
    const warning = `封存位置位於另一個 git 工作區 ${other.stdout.trim()}，且未被忽略`;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
}

export function resolveArchiveRoot({ archiveRoot, outputDir, worktrees, settings }) {
  if (!settings && !archiveRoot && !process.env.BDD_ARCHIVE_ROOT) {
    settings = loadBddOutputConfig(outputDir, worktrees[0]);
  }
  const [rootSource, value] = [
    ['parameter', archiveRoot], ['env:BDD_ARCHIVE_ROOT', process.env.BDD_ARCHIVE_ROOT],
    ['config:' + settings?.file, settings?.config.archiveRoot], ['default', path.join(os.homedir(), 'bdd-archives', path.basename(worktrees[0]))],
  ].find(([, value]) => value);
  const expanded = value.replace(/^~(?=[\\/]|$)/, () => os.homedir());
  if (!path.isAbsolute(expanded) || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(expanded))) {
    throw new Error(`封存位置必須是絕對路徑（來源 ${rootSource}）：${value}`);
  }
  return { root: path.resolve(expanded), rootSource };
}

export async function archiveLocation({ options, settings, worktrees, topic, commit, issue, warnings }) {
  const { root, rootSource } = resolveArchiveRoot({ archiveRoot: options['archive-root'], worktrees, settings });
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  const stamp = local.toISOString().slice(0, 19).replace(/[-:]/g, '');
  const target = options.destination ? path.resolve(options.destination) :
    path.join(root, safePathComponent(issue || '_unnumbered'), topic + '-' + safePathComponent(commit.slice(0, 7)) + '-' + stamp + '.zip');
  const index = path.join(root, 'index.jsonl');
  if ([index, index + '.lock'].some(file => path.relative(file, target) === '')) throw new Error('封存目的地不可與索引檔相同');
  await outsideWorktrees(root, worktrees, warnings);
  await outsideWorktrees(target, worktrees, warnings);
  if (await statIfPresent(target)) throw new Error(`封存檔已存在，請使用新檔名：${target}`);
  return { root, rootSource, target, index };
}

async function publish(temporary, location, created) {
  const { index, target } = location;
  return withIndexLock(index, async stat => {
    const previous = await previousArchives(index, stat, created);
    try {
      await link(temporary, target);
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`封存檔已存在：${target}`);
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(err.code)) throw err;
      await copyFile(temporary, target, constants.COPYFILE_EXCL);
    }
    try {
      const events = [created, ...previous.map(archive => ({ event: 'status', archive, status: 'superseded', by: target, at: created.at }))];
      await appendIndexEvents(index, stat, events);
    } catch (err) {
      await unlink(target);
      throw err;
    }
    return previous;
  });
}

export async function writeVerifiedArchive(temporary, plan, manifest) {
  const { openZip, writeZip } = await import('./zip-io.mjs');
  const prefix = manifest.topic + '/';
  const data = Buffer.from(JSON.stringify(manifest, null, 2));
  const restored = Object.values(plan.files);
  if (restored.length > entryLimit || plan.stored.length + 1 > entryLimit) throw new Error('封存超出還原項目數上限：' + entryLimit);
  if (restored.reduce((sum, entry) => sum + entry.size, 0) > byteLimit) throw new Error('封存超出還原位元組上限：' + byteLimit);
  if (data.length > manifestLimit) throw new Error('封存 manifest 超出 8 MiB 上限');
  const metadata = { name: prefix + 'bdd-manifest.json', data, size: data.length, sha256: hashBytes(data) };
  const records = [...plan.stored.map(entry => ({ ...entry, name: prefix + entry.name,
    compress: !/\.(png|jpe?g|webp|gif|zip|gz|7z|mp4|webm|pdf)$/i.test(entry.name) })), metadata];
  const expected = new Map(records.map(record => [record.name, record]));
  await writeZip(temporary, records);
  try {
    const before = await lstat(temporary, { bigint: true });
    const zip = await openZip(temporary);
    try {
      for (const entry of zip.entries) {
        const record = expected.get(entry.name);
        if (!record || entry.isDirectory || record.size !== entry.size || await hashStream(await entry.open()) !== record.sha256) {
          throw new Error(`封存內容不符：${entry.name}`);
        }
        expected.delete(entry.name);
      }
      if (expected.size) throw new Error(`封存缺少檔案：${expected.keys().next().value}`);
    } finally { await zip.close(); }
    const sha256 = await hashStream(createReadStream(temporary, sequentialReadOptions(before.size)));
    const after = await lstat(temporary, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('核對期間封存檔已變動');
    return { sha256, sizeBytes: Number(after.size) };
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}

export async function storeArchive(location, plan, manifest, event) {
  const dir = path.dirname(location.target);
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, '.bdd-' + randomUUID() + '.zip.tmp');
  const { sha256, sizeBytes } = await writeVerifiedArchive(temporary, plan, manifest);
  try {
    const superseded = await publish(temporary, location, { ...event, sha256, bytes: sizeBytes });
    return { sha256, sizeBytes, superseded };
  } finally {
    await unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err; });
  }
}
