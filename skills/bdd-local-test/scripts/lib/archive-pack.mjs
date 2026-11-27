import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { entryLimit, safePathComponent } from './archive-limits.mjs';
import { stageSnapshots } from './archive-snapshots.mjs';

export async function hashStream(stream) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex').toUpperCase();
}

export function hashBytes(data) {
  return createHash('sha256').update(data).digest('hex').toUpperCase();
}

export async function fileEntry(name, filePath, extra = {}) {
  const stat = await lstat(filePath);
  if (!stat.isFile()) throw new Error(`來源不是一般檔案：${filePath}`);
  return { name, path: filePath, size: stat.size, mtime: stat.mtime,
    sha256: await hashStream(createReadStream(filePath)), extra };
}

export async function sourceFiles(source) {
  const files = [];
  let fileCount = 0;
  const names = new Set();
  async function visit(dir, prefix) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + safePathComponent(item.name);
      if (/^(?:masking\.json\.lock$|\.bdd-(?:mask-stage|extract|prune)-)/i.test(item.name)) {
        throw new Error(`遮罩、還原或清理作業尚未完成，請稍後重試：${name}`);
      }
      if (!prefix && name.toLowerCase() === 'bdd-manifest.json') throw new Error('輸出目錄不可自帶 bdd-manifest.json');
      const key = name.toLowerCase();
      if (names.has(key)) throw new Error(`封存內有重複的路徑：${name}`);
      names.add(key);
      if (item.isSymbolicLink()) throw new Error(`BDD 輸出含符號連結或 junction：${name}`);
      const filePath = path.join(dir, item.name);
      if (item.isDirectory()) await visit(filePath, name + '/');
      else if (item.isFile()) {
        if (key !== 'evidence.zip' && ++fileCount > entryLimit) throw new Error('封存超出還原項目數上限：' + entryLimit);
        files.push({ name, path: filePath });
      }
      else throw new Error(`來源不是一般檔案：${filePath}`);
    }
  }
  await visit(source, '');
  return files;
}

export function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

export async function addSnapshots(entries, repo, commit, scenarios, staging) {
  if (!scenarios.length) return;
  const existing = new Map(entries.map(entry => [entry.name.toLowerCase(), entry]));
  const names = new Set(existing.keys());
  const snapshots = scenarios.map(scenario => {
    const { blob, role } = scenario;
    if (!blob) throw new Error(`情境檔受測時尚未提交：${scenario.path}`);
    const scenarioPath = scenario.path.replaceAll('\\', '/');
    scenarioPath.split('/').forEach(safePathComponent);
    const name = 'features/' + scenarioPath.replace(/^\.bdd\/modules\//, '');
    names.add(name.toLowerCase());
    if (names.size > entryLimit) throw new Error('封存超出還原項目數上限：' + entryLimit);
    return { name, scenarioPath, blob, extra: { scenarioPath: scenario.path, blob, role: role ?? null } };
  });
  const staged = await stageSnapshots(repo, commit, snapshots, staging);
  for (const { name, blob, extra } of snapshots) {
    const snapshot = { ...staged.get(blob), name, extra };
    const prior = existing.get(name.toLowerCase());
    if (prior) {
      if (prior.sha256 !== snapshot.sha256 || prior.name !== name) {
        throw new Error(`輸出資料夾已有 ${name}，但內容與受測 commit 的情境不同`);
      }
      prior.extra = snapshot.extra;
    } else {
      entries.push(snapshot);
      existing.set(name.toLowerCase(), snapshot);
    }
  }
}

export function deduplicate(entries) {
  const files = Object.create(null);
  const aliases = Object.create(null);
  const canonical = new Map();
  const stored = [];
  const directories = new Set();
  const paths = new Set();
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const key = entry.name.toLowerCase();
    let ancestor = path.posix.dirname(key);
    while (ancestor !== '.') {
      if (paths.has(ancestor)) throw new Error(`封存內的檔案與目錄衝突：${entry.name}`);
      directories.add(ancestor);
      ancestor = path.posix.dirname(ancestor);
    }
    if (paths.has(key) || directories.has(key)) throw new Error(`封存內有重複的路徑：${entry.name}`);
    paths.add(key);
    files[entry.name] = { sha256: entry.sha256, size: entry.size, ...entry.extra };
    if (canonical.has(entry.sha256)) aliases[entry.name] = canonical.get(entry.sha256);
    else {
      stored.push(entry);
      canonical.set(entry.sha256, entry.name);
    }
  }
  return { files, aliases, stored };
}
