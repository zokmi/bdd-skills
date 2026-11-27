import { constants, createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdtemp, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { appendIndexEvents, archiveKey, findArchiveIndexRoot, readArchiveStates, withIndexLock } from './archive-index.mjs';
import { deduplicate, hashStream } from './archive-pack.mjs';
import { writeVerifiedArchive } from './archive-store.mjs';
import { isWebpCandidate, optimizeImages } from './archive-images.mjs';
import { safePathComponent } from './archive-limits.mjs';
import { decodeArchiveText } from './archive-text.mjs';
import { planArchiveInventory, stageEntry } from './extract.mjs';
import { parseMaskLedger } from './mask-ledger.mjs';
import { openZip } from './zip-io.mjs';

function absolutePath(value) {
  return path.resolve(value.replace(/^~(?=[\\/]|$)/, () => os.homedir()));
}

async function inspectArchive(archive) {
  const stat = await lstat(archive);
  if (!stat.isFile() || path.relative(archive, await realpath(archive)) !== '') {
    throw new Error('封存檔或上層目錄含連結，或不是一般檔案：' + archive);
  }
  return stat;
}

async function checkLeftovers(archive) {
  for (const [suffix, kind] of [['.bak', '備份'], ['.recompress.zip', '暫存檔']]) {
    try { await lstat(archive + suffix); }
    catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    throw new Error('上次重新壓縮留下的' + kind + '仍在，請先確認：' + archive + suffix);
  }
}

async function indexedArchive(index, archive) {
  const [state] = await readArchiveStates(index, { archive });
  if (!state) throw new Error('索引裡沒有這個封存檔：' + archive);
  return state;
}

async function verifyDigest(file, expected) {
  const actual = await hashStream(createReadStream(file));
  if (actual !== expected) throw new Error(`封存檔 SHA-256 與索引記錄不同（記錄 ${expected}、目前 ${actual}），拒絕重新壓縮`);
}

function sourceDirectory(files, root, folder) {
  let inferred;
  for (const { file } of files.values()) {
    const relative = path.relative(root, file);
    const separator = relative.indexOf(path.sep);
    const first = separator === -1 ? null : relative.slice(0, separator);
    const parent = first && path.join(root, first);
    if (folder) {
      if (!parent || path.relative(folder, parent)) throw new Error('封存含有 manifest topic 以外的檔案');
    } else {
      if (!parent || /^(evidence|features)$/i.test(first) || (inferred && path.relative(inferred, parent))) return root;
      inferred = parent;
    }
  }
  return folder ?? inferred ?? root;
}

export async function stageArchiveEntries(snapshot, staging, indexedTopic, { skipStagingWithoutImages = false } = {}) {
  const zip = await openZip(snapshot);
  try {
    const virtualRoot = path.join(staging, 'src');
    const { files, folder, manifest } = await planArchiveInventory(zip.entries, virtualRoot);
    const source = sourceDirectory(files, virtualRoot, folder);
    const topic = safePathComponent(source === virtualRoot ? indexedTopic : path.basename(source));
    const logicalFiles = Array.from(files.values(), item => ({ item, name: path.relative(source, item.file).split(path.sep).join('/') }));
    const stage = !skipStagingWithoutImages || logicalFiles.some(({ name }) => isWebpCandidate(name));
    let count = 0;
    for (const { item, name } of logicalFiles) {
      if (item.entry) {
        if (stage) {
          item.staged = path.join(staging, 'payload-' + count++);
          item.hash = await stageEntry(item.entry, item.staged);
        } else {
          item.hash = await hashStream(await item.entry.open());
        }
      }
      // The inventory lists physical ZIP entries first. Aliases reuse their bytes while retaining individual metadata.
      const payload = item.original ?? item;
      if (item.expectedHash && payload.hash !== item.expectedHash) throw new Error('還原後內容不符：' + name);
    }
    if (!stage) return { entries: [], topic, manifest };

    const records = new Map(Object.entries(manifest?.files ?? {}).map(([name, details]) =>
      [archiveKey(path.join(source, name.replaceAll('\\', '/'))), details]));
    const entries = logicalFiles.map(({ item, name }) => {
      const payload = item.original ?? item;
      const extra = { ...records.get(archiveKey(item.file)) };
      delete extra.size;
      delete extra.sha256;
      return { name, path: payload.staged, sha256: payload.hash, size: item.size, mtime: item.mtime, extra };
    });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { entries, topic, manifest };
  } finally { await zip.close(); }
}

async function loadLedger(entries) {
  const entry = entries.find(item => item.name.toLowerCase() === 'masking.json');
  if (!entry) return parseMaskLedger('{}');
  return parseMaskLedger(decodeArchiveText(await readFile(entry.path)));
}

async function backupOriginal(archive, backup) {
  try { await link(archive, backup); }
  catch (err) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(err.code)) throw err;
    await copyFile(archive, backup, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  }
}

async function replaceArchive(index, archive, replacement, event) {
  const backup = archive + '.bak';
  await withIndexLock(index, async stat => {
    const current = await indexedArchive(index, archive);
    if (String(current.sha256).toUpperCase() !== event.previousSha256) {
      throw new Error('重新壓縮期間封存索引已變更，請重試：' + archive);
    }
    await checkLeftovers(archive);
    await inspectArchive(archive);
    // Keep the original reachable until both the atomic replacement and index append succeed.
    await backupOriginal(archive, backup);
    try {
      await verifyDigest(backup, event.previousSha256);
      await rename(replacement, archive);
    } catch (err) {
      await unlink(backup);
      throw err;
    }
    try {
      await appendIndexEvents(index, stat, [event]);
    } catch (err) {
      await rename(backup, archive);
      throw err;
    }
    await unlink(backup);
  });
}

async function recompress(archive, root) {
  const index = path.join(root, 'index.jsonl');
  await inspectArchive(archive);
  const state = await indexedArchive(index, archive);
  const previousSha256 = String(state.sha256).toUpperCase();
  await checkLeftovers(archive);
  const staging = await mkdtemp(path.join(await realpath(os.tmpdir()), 'bdd-recompress-'));
  try {
    // Extract the exact bytes checked against the index, even if another process replaces the ZIP.
    const snapshot = path.join(staging, 'input.zip');
    await copyFile(archive, snapshot, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await verifyDigest(snapshot, previousSha256);
    const previousBytes = (await lstat(snapshot)).size;
    const { entries, topic, manifest } = await stageArchiveEntries(snapshot, staging, state.topic, { skipStagingWithoutImages: true });
    await unlink(snapshot);
    const { webp, rewrittenLinks, verifiedOriginalSha256 } =
      await optimizeImages(entries, () => loadLedger(entries), 'required', staging, []);
    const { converted, skipped } = webp;
    const summary = { archive, previousBytes, converted, skipped };
    if (!converted) return { ...summary, changed: false, bytes: previousBytes, savedBytes: 0, sha256: previousSha256 };

    const plan = deduplicate(entries);
    const at = new Date().toISOString();
    const metadata = manifest ?? {
      tool: 'bdd-local-test/bdd.mjs recompress', legacy: true, issue: state.issue, commit: state.commit,
      masked: false, unmaskedReason: '舊版封存，未經遮罩登記檢查',
    };
    const updated = {
      ...metadata, schema: 2, topic, storedFileCount: plan.stored.length, files: plan.files, aliases: plan.aliases,
      webp, rewrittenLinks, recompressedFrom: { sha256: previousSha256, bytes: previousBytes, at },
    };
    const output = await mkdtemp(path.join(path.dirname(archive), '.bdd-recompress-'));
    try {
      const replacement = path.join(output, 'verified.zip');
      const { sha256, sizeBytes: bytes } = await writeVerifiedArchive(replacement, plan, updated);
      const event = { event: 'recompressed', archive: state.archive,
        previousSha256, previousBytes, sha256, bytes, encoder: webp.encoder, converted, at };
      if (state.legacy || updated.legacy) event.verifiedOriginalSha256 = verifiedOriginalSha256;
      await replaceArchive(index, archive, replacement, event);
      return { ...summary, changed: true, bytes, savedBytes: previousBytes - bytes, sha256 };
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function recompressCommand(args) {
  const { values } = parseArgs({ args, options: { archive: { type: 'string' }, 'archive-root': { type: 'string' } } });
  if (!values.archive) throw new Error('請以 --archive 指定封存檔');
  const archive = absolutePath(values.archive);
  const root = values['archive-root'] ? absolutePath(values['archive-root']) : await findArchiveIndexRoot(archive);
  console.log(JSON.stringify(await recompress(archive, root)));
  return 0;
}
