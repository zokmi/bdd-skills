import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { openZip } from './zip-io.mjs';
import { entryLimit, byteLimit, manifestLimit, safePathComponent } from './archive-limits.mjs';
import { decodeArchiveText } from './archive-text.mjs';

const pathKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function zipPath(root, name) {
  if (typeof name !== 'string') throw new Error('封存項目缺少路徑');
  const parts = name.replaceAll('\\', '/').split('/');
  for (const part of parts) safePathComponent(part);
  return path.join(root, ...parts);
}

function inspect(file, directory) {
  const parent = path.dirname(file);
  if (parent !== file) inspect(parent, true);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error('解壓路徑含重新解析點：' + file);
  if (stat && !(directory ? stat.isDirectory() : stat.isFile())) {
    throw new Error('解壓路徑與現有檔案或目錄衝突：' + file);
  }
  return stat;
}

async function readManifest(entry) {
  if (entry.size > manifestLimit) throw new Error('封存 manifest 超出 8 MiB 上限');
  const chunks = [];
  let size = 0;
  for await (const bytes of await entry.open()) {
    size += bytes.length;
    if (size > entry.size) throw new Error('封存 manifest 實際大小與宣告不符');
    chunks.push(bytes);
  }
  if (size !== entry.size) throw new Error('封存 manifest 實際大小與宣告不符');
  return JSON.parse(decodeArchiveText(Buffer.concat(chunks, size)));
}

export async function planArchiveInventory(entries, destination, {
  evidenceZip = false, maxEntries = entryLimit, maxOutputBytes = byteLimit,
} = {}) {
  destination = path.resolve(destination);
  if (entries.length > maxEntries) throw new Error('封存超出 ZIP 項目數上限：' + maxEntries);
  const files = new Map();
  const directories = new Set();
  let header, folder = null, manifest = null, verifiedFiles = 0;
  for (const entry of entries) {
    if (entry.isSymlink) throw new Error('封存項目不可為連結：' + entry.name);
    const normalized = entry.name.replaceAll('\\', '/');
    const name = entry.isDirectory ? normalized.replace(/\/$/, '') : normalized;
    let outputName = name;
    if (evidenceZip) {
      const hasPrefix = /^evidence\//i.test(normalized);
      outputName = hasPrefix ? 'evidence' + name.slice('evidence'.length) : 'evidence/' + name;
    }
    const file = zipPath(destination, outputName);
    if (entry.isDirectory) {
      directories.add(pathKey(file));
      continue;
    }
    if (!evidenceZip && /^[^/]+\/bdd-manifest\.json$/i.test(name)) {
      if (header) throw new Error('封存含多個 manifest');
      header = entry;
      continue;
    }
    const key = pathKey(file);
    if (files.has(key)) throw new Error('封存路徑重複：' + name);
    files.set(key, { file, entry, size: entry.size, mtime: entry.mtime });
  }
  if (header) {
    manifest = await readManifest(header);
    const prefix = header.name.replaceAll('\\', '/').split('/')[0];
    if (typeof manifest?.topic !== 'string' || /[/\\]/.test(manifest.topic) ||
        (manifest.topic !== prefix && manifest.legacy !== true)) throw new Error('封存 manifest 的 topic 無效');
    zipPath(destination, manifest.topic);
    folder = zipPath(destination, prefix);
    for (const field of ['aliases', 'files']) {
      if (manifest[field] != null && !isObject(manifest[field])) throw new Error('封存 manifest 的 ' + field + ' 無效');
    }
    for (const [name, source] of Object.entries(manifest.aliases ?? {})) {
      const file = zipPath(folder, name);
      const key = pathKey(file);
      const original = files.get(pathKey(zipPath(folder, source)));
      if (files.has(key) || !original?.entry || key === pathKey(zipPath(destination, header.name))) {
        throw new Error('封存 manifest 的 alias 無效：' + name);
      }
      if (files.size >= maxEntries) throw new Error('封存超出還原檔案數上限：' + maxEntries);
      files.set(key, { file, original, size: original.size, mtime: original.mtime });
    }
    for (const [name, record] of Object.entries(manifest.files ?? {})) {
      const item = files.get(pathKey(zipPath(folder, name)));
      if (!item) throw new Error('還原後缺少檔案：' + name);
      if (item.expectedHash) throw new Error('封存 manifest 的檔案路徑重複：' + name);
      if (typeof record?.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(record.sha256)) {
        throw new Error('封存 SHA-256 無效：' + name);
      }
      item.expectedHash = record.sha256.toUpperCase();
      verifiedFiles++;
    }
    if (manifest.schema === 2 && verifiedFiles !== files.size) {
      throw new Error('封存 manifest 沒有列出所有還原檔案的 SHA-256');
    }
  }
  let remaining = maxOutputBytes;
  for (const item of files.values()) {
    remaining -= item.size;
    if (remaining < 0) throw new Error('封存超出還原位元組上限：' + maxOutputBytes);
    if (directories.has(pathKey(item.file))) throw new Error('封存檔案與目錄路徑衝突：' + item.file);
    for (let dir = path.dirname(item.file); dir !== destination; dir = path.dirname(dir)) {
      if (files.has(pathKey(dir))) throw new Error('封存檔案與目錄路徑衝突：' + dir);
    }
  }
  return { files, manifest, folder, verifiedFiles };
}

export async function stageEntry(entry, file) {
  const digest = createHash('sha256');
  const hashAndForward = new Transform({
    transform(bytes, encoding, done) {
      digest.update(bytes);
      done(null, bytes);
    },
  });
  await pipeline(await entry.open(), hashAndForward, fs.createWriteStream(file, { flags: 'wx' }));
  return digest.digest('hex').toUpperCase();
}

async function identicalExisting(item) {
  const stat = inspect(item.file, false);
  if (!stat) return null;
  if (stat.size === item.size) {
    const hash = createHash('sha256');
    for await (const bytes of fs.createReadStream(item.file)) hash.update(bytes);
    if (hash.digest('hex').toUpperCase() === item.hash) return stat;
  }
  throw new Error('目的地已有同名但內容不同的檔案，不覆蓋：' + item.file);
}

function sameFileVersion(a, b) {
  return b && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function ensureDirectory(dir, created) {
  if (inspect(dir, true)) return;
  ensureDirectory(path.dirname(dir), created);
  try {
    fs.mkdirSync(dir);
    created.push(dir);
  } catch (error) {
    if (error.code !== 'EEXIST' || !inspect(dir, true)) throw error;
  }
}

function publishFile(item) {
  try {
    // link() is an atomic, no-overwrite publication on the same filesystem.
    fs.linkSync(item.staged, item.file);
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(error.code)) throw error;
    fs.copyFileSync(item.staged, item.file, fs.constants.COPYFILE_EXCL);
    return true;
  }
  return false;
}

export async function expandArchive({ archive, to, evidenceZip = false, maxEntries = entryLimit, maxOutputBytes = byteLimit }) {
  if (!archive || !to) throw new Error('請指定 --archive 與 --to');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > entryLimit ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > byteLimit) {
    throw new Error('解壓限制無效');
  }
  const archivePath = path.resolve(archive);
  const destination = path.resolve(to);
  inspect(destination, true);
  const zip = await openZip(archivePath, { maxEntries });
  let staging;
  const createdDirs = [];
  const published = [];
  let complete = false;
  try {
    const { files, manifest, folder, verifiedFiles } = await planArchiveInventory(zip.entries, destination, {
      evidenceZip, maxEntries, maxOutputBytes,
    });
    for (const item of files.values()) inspect(item.file, false);
    ensureDirectory(destination, createdDirs);
    staging = fs.mkdtempSync(path.join(destination, '.bdd-extract-'));
    let index = 0, written = 0, restoredAliases = 0, skippedIdentical = 0;
    for (const item of files.values()) {
      item.staged = path.join(staging, String(index++));
      if (item.entry) item.hash = await stageEntry(item.entry, item.staged);
      else item.hash = item.original.hash;
      if (item.expectedHash && item.hash !== item.expectedHash) throw new Error('還原後內容不符：' + item.file);
      item.existing = await identicalExisting(item);
      // An alias must be independently editable after restoration.
      if (!item.existing && item.original) fs.copyFileSync(item.original.staged, item.staged, fs.constants.COPYFILE_FICLONE);
      if (!item.existing && item.mtime) fs.utimesSync(item.staged, item.mtime, item.mtime);
    }
    for (const item of files.values()) {
      if (item.existing) {
        if (sameFileVersion(item.existing, inspect(item.file, false)) || await identicalExisting(item)) {
          skippedIdentical++;
          continue;
        }
        if (item.original) fs.copyFileSync(item.original.staged, item.staged, fs.constants.COPYFILE_FICLONE);
        if (item.mtime) fs.utimesSync(item.staged, item.mtime, item.mtime);
      }
      ensureDirectory(path.dirname(item.file), createdDirs);
      inspect(item.file, false);
      let copied;
      try { copied = publishFile(item); }
      catch (error) {
        if (error.code === 'EEXIST' && await identicalExisting(item)) { skippedIdentical++; continue; }
        throw error;
      }
      const publication = { file: item.file, stat: fs.lstatSync(item.file) };
      published.push(publication);
      if (copied && item.mtime) {
        fs.utimesSync(item.file, item.mtime, item.mtime);
        publication.stat = fs.lstatSync(item.file);
      }
      if (item.original) restoredAliases++; else written++;
    }
    complete = true;
    return {
      archive: archivePath, destination, folder, hasManifest: manifest !== null,
      written, restoredAliases, skippedIdentical, verifiedFiles, manifest,
      hashes: Object.fromEntries(Array.from(files.values(), item => [item.file, item.hash])),
      writtenPaths: published.map(p => p.file),
    };
  } finally {
    try {
      if (!complete) {
        for (const { file, stat } of published.reverse()) {
          inspect(path.dirname(file), true);
          const now = fs.lstatSync(file, { throwIfNoEntry: false });
          if (sameFileVersion(stat, now)) fs.unlinkSync(file);
        }
      }
    } finally {
      try {
        if (staging) {
          inspect(staging, true);
          fs.rmSync(staging, { recursive: true, force: true });
        }
        if (!complete) {
          for (const dir of createdDirs.reverse()) {
            inspect(dir, true);
            try { fs.rmdirSync(dir); }
            catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
          }
        }
      } finally { await zip.close(); }
    }
  }
}

export async function extractCommand(args) {
  const { values } = parseArgs({ args, options: { archive: { type: 'string' }, to: { type: 'string' } } });
  const { hashes, writtenPaths, manifest, ...summary } = await expandArchive(values);
  console.log(JSON.stringify(summary));
  return 0;
}
