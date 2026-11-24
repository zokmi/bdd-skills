import { spawn, spawnSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, readFile, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fileEntry, hashBytes, hashStream } from './archive-pack.mjs';
import { deleteMaskRecord, maskRecord, setMaskRecord } from './mask-ledger.mjs';
import { decodeArchiveText } from './archive-text.mjs';

const helper = fileURLToPath(new URL('./bdd_webp.py', import.meta.url));
const candidate = name => /^evidence\/.*\.(?:png|jpe?g|bmp)$/is.test(name);

function findPillow() {
  const wanted = (process.env.BDD_WEBP_ENCODER || 'auto').toLowerCase();
  if (wanted === 'none') return null;
  for (const [command, ...args] of [['python'], ['python3'], ['py', '-3']]) {
    const probe = spawnSync(command, [...args, helper, 'check'], { encoding: 'utf8', windowsHide: true });
    if (probe.status !== 0) continue;
    try {
      if (JSON.parse(probe.stdout).ok === true) return { command, args };
    } catch { /* Try the next interpreter. */ }
  }
  if (wanted === 'pillow') throw new Error('BDD_WEBP_ENCODER=pillow，但找不到支援 WebP 的 Python Pillow');
  return null;
}

function pillowBatch({ command, args }) {
  const child = spawn(command, [...args, helper, 'batch'], {
    windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  // A worker may exit between two requests. A rejected write or EOF keeps that image in its original format.
  const closed = once(child, 'close').catch(() => {});
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    async convert(source, destination) {
      try {
        await new Promise((resolve, reject) => child.stdin.write(JSON.stringify({ source, destination }) + '\n',
          err => err ? reject(err) : resolve()));
        return JSON.parse((await lines.next()).value);
      } catch { return {}; }
    },
    async close() {
      child.stdin.end();
      await closed;
    },
  };
}

async function convertImage(entry, batch, staging, cacheKey) {
  // The pixels presented to Pillow must be the same bytes whose hash the ledger attests to.
  const input = path.join(staging, 'input' + path.extname(entry.name));
  const output = path.join(staging, cacheKey + '.webp');
  await copyFile(entry.path, input, constants.COPYFILE_FICLONE);
  try {
    if (await hashStream(createReadStream(input)) !== entry.sha256) throw new Error(`封存時來源已變動：${entry.name}`);
    const result = await batch.convert(input, output);
    if (result.identical === false) return { reason: 'not-identical' };
    if (result.identical !== true) return { reason: 'encoder-failed' };
    const image = await fileEntry('', output);
    if (image.size >= entry.size) return { reason: 'not-smaller' };
    return { image };
  } finally {
    await unlink(input);
  }
}

function urlPath(name) {
  return name.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,
    char => '%' + char.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

function replaceData(entry, text) {
  const data = Buffer.from(text);
  return { ...entry, path: undefined, data, sha256: hashBytes(data), size: data.length };
}

async function rewriteReferences(entries, ledger, converted, rewrittenLinks) {
  const pairs = new Map();
  let ledgerChanged = false;
  for (const image of converted) {
    const { originalName, originalSha256 } = image.extra;
    pairs.set(originalName, image.name);
    pairs.set(urlPath(originalName), urlPath(image.name));
    const old = maskRecord(ledger, originalName);
    if (!old || String(old.sha256).toUpperCase() !== originalSha256) continue;
    deleteMaskRecord(ledger, originalName);
    setMaskRecord(ledger, image.name, { ...old, sha256: image.sha256, derivedFrom: { name: originalName, sha256: old.sha256 } });
    ledgerChanged = true;
  }
  for (const [i, entry] of entries.entries()) {
    if (ledgerChanged && entry.name.toLowerCase() === 'masking.json') {
      entries[i] = replaceData(entry, JSON.stringify(ledger, null, 2) + '\n');
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      const bytes = await readFile(entry.path);
      if (hashBytes(bytes) !== entry.sha256) throw new Error(`封存時來源已變動：${entry.name}`);
      let text = decodeArchiveText(bytes);
      let count = 0;
      for (const [from, to] of pairs) {
        const parts = text.split(from);
        if (parts.length === 1) continue;
        count += parts.length - 1;
        text = parts.join(to);
      }
      if (count) {
        entries[i] = replaceData(entry, text);
        rewrittenLinks[entry.name] = count;
      }
    }
  }
}

export async function optimizeImages(entries, ledger, setting, staging, warnings) {
  const webp = { encoder: null, converted: 0, skipped: [], savedBytes: 0 };
  const rewrittenLinks = Object.create(null);
  if (setting === 'off' || (setting !== 'required' && !entries.some(e => candidate(e.name)))) {
    return { webp, rewrittenLinks, verifiedOriginalSha256: [] };
  }
  const encoder = findPillow();
  if (!encoder) {
    if (setting === 'required') throw new Error('沒有可用的 WebP 編碼器（需要支援 WebP 的 Python Pillow），無法重新壓縮');
    warnings.push('webpUnavailable：找不到支援 WebP 的 Python Pillow，截圖保留原格式');
    return { webp, rewrittenLinks, verifiedOriginalSha256: [] };
  }
  webp.encoder = 'pillow';
  const names = new Set(entries.map(e => e.name.toLowerCase()));
  const cache = new Map();
  const converted = [];
  let batch;
  try {
    for (const [i, entry] of entries.entries()) {
      if (!candidate(entry.name)) continue;
      const name = entry.name.replace(/\.[^.]+$/, '.webp');
      if (names.has(name.toLowerCase())) {
        webp.skipped.push({ file: entry.name, reason: 'name-conflict' });
        continue;
      }
      const format = path.extname(entry.name).slice(1).toLowerCase().replace(/^jpg$/, 'jpeg');
      const cacheKey = entry.sha256 + '-' + format;
      if (!cache.has(cacheKey)) {
        batch ??= pillowBatch(encoder);
        cache.set(cacheKey, await convertImage(entry, batch, staging, cacheKey));
      }
      const { image, reason } = cache.get(cacheKey);
      if (reason) { webp.skipped.push({ file: entry.name, reason }); continue; }
      names.add(name.toLowerCase());
      const extra = { ...entry.extra, originalName: entry.name, originalSha256: entry.sha256, encoder: 'pillow', lossless: true };
      entries[i] = { ...image, name, mtime: entry.mtime, extra };
      converted.push(entries[i]);
      webp.savedBytes += entry.size - image.size;
    }
  } finally {
    if (batch) await batch.close();
  }
  webp.converted = converted.length;
  if (converted.length) {
    const records = typeof ledger === 'function' ? await ledger() : ledger;
    await rewriteReferences(entries, records, converted, rewrittenLinks);
  }
  const verifiedOriginalSha256 = [...new Set(converted.map(image => image.extra.originalSha256))];
  return { webp, rewrittenLinks, verifiedOriginalSha256 };
}
