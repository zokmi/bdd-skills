import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const isEvidenceImage = file => /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(file);
// A Windows archive may have recorded evidence/ even when its ZIP uses EVIDENCE/.
export const evidencePathKey = name => process.platform === 'win32' ? name.toLowerCase() : name.replace(/^evidence\//i, 'evidence/');
const keys = Symbol('evidence paths');

export function evidenceFolder(root) {
  const names = fs.readdirSync(root).filter(name => name.toLowerCase() === 'evidence');
  if (names.length > 1) throw new Error('Ambiguous evidence directories in ' + root);
  return names[0];
}

export function sha256File(file) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
    return digest.digest('hex').toUpperCase();
  } finally {
    fs.closeSync(fd);
  }
}

export function readMaskLedger(dir) {
  const file = path.join(dir, 'masking.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error('Invalid masking ledger file: ' + file);
  return parseMaskLedger(stat ? fs.readFileSync(file, 'utf8') : '{}');
}

export function parseMaskLedger(text) {
  const ledger = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) ||
      (Object.hasOwn(ledger, 'files') && (!ledger.files || typeof ledger.files !== 'object' || Array.isArray(ledger.files)))) {
    throw new Error('Invalid files in masking.json');
  }
  ledger.files ??= {};
  ledger[keys] = new Map();
  for (const name of Object.keys(ledger.files)) {
    const key = evidencePathKey(name);
    if (ledger[keys].has(key)) throw new Error('Duplicate evidence path in masking.json: ' + name);
    ledger[keys].set(key, name);
  }
  return ledger;
}

export function maskRecord(ledger, relative) {
  const name = ledger[keys].get(evidencePathKey(relative));
  return name === undefined ? undefined : ledger.files[name];
}

export function setMaskRecord(ledger, relative, record) {
  const key = evidencePathKey(relative);
  const before = ledger[keys].get(key);
  if (before && before !== relative) delete ledger.files[before];
  ledger.files[relative] = record;
  ledger[keys].set(key, relative);
}

export function deleteMaskRecord(ledger, relative) {
  const key = evidencePathKey(relative);
  const name = ledger[keys].get(key);
  if (name !== undefined) delete ledger.files[name];
  ledger[keys].delete(key);
}

// The lock doubles as the staged ledger. Readers can always open the last complete version.
export async function updateMaskLedger(dir, edit) {
  const file = path.join(dir, 'masking.json');
  const lock = file + '.lock';
  const deadline = Date.now() + 10000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error('遮罩紀錄鎖定中。若寫入程序仍在執行，請稍後重試。若程序已終止，請備份並檢查鎖檔內的未發布紀錄，再移走鎖檔重試：' + lock);
      await delay(50);
    }
  }
  let published = false;
  try {
    const ledger = readMaskLedger(dir);
    const result = await edit(ledger);
    ledger.files = Object.fromEntries(Object.entries(ledger.files).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(fd, JSON.stringify(ledger, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(lock, file);
    published = true;
    return result;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!published) fs.unlinkSync(lock);
  }
}
