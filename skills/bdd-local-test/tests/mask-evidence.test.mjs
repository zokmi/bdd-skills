import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256File } from '../scripts/lib/mask-ledger.mjs';
import { evidenceChecker } from '../scripts/lib/summary-evidence.mjs';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const execute = promisify(execFile);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-test-mask-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.bdd', '報告');
  const images = path.join(dir, 'evidence');
  fs.mkdirSync(images, { recursive: true });
  const ledger = path.join(dir, 'masking.json');
  function run(...args) {
    return execute(process.execPath, [cli, 'mask-evidence', '--dir', dir, ...args]).then(r => JSON.parse(r.stdout));
  }
  return { dir, images, ledger, run };
}

test('status and concurrent marks retain existing ledger fields and detect later edits', async t => {
  const { dir, images, ledger, run } = fixture(t);
  const a = path.join(images, '舊.png');
  const b = path.join(images, 'new#1.webp');
  const c = path.join(images, 'other.gif');
  for (const [i, file] of [a, b, c].entries()) fs.writeFileSync(file, 'fixture' + i);
  fs.writeFileSync(path.join(images, 'report.txt'), 'report');
  fs.writeFileSync(ledger, '\uFEFF' + JSON.stringify({ schema: 1, files: {
    'evidence/舊.png': { sha256: sha256File(a).toLowerCase(), method: 'css', note: '歷史紀錄' },
  } }));
  assert.equal((await run('--status')).masked, 1);
  await assert.rejects(run('--mark', '--method', 'exempt'), /--note/);
  await Promise.all([
    run('--mark', '--method', 'css', '--pattern', 'NEW#?.WEBP'),
    run('--mark', '--method', 'exempt', '--note', 'synthetic', '--pattern', 'evidence/othe[r].gif'),
  ]);
  assert.equal((await run('--status')).masked, 3);
  const saved = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(saved.schema, 1);
  assert.equal(saved.files['evidence/舊.png'].note, '歷史紀錄');
  assert.equal(saved.files['evidence/new#1.webp'].sha256, sha256File(b));
  fs.appendFileSync(b, 'changed');
  assert.deepEqual((await run('--status')).unmasked, ['evidence/new#1.webp']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['evidence', 'masking.json']);
});

test('an exemption requires a reason and applying a mask requires configured rectangles', async t => {
  const { images, ledger, run } = fixture(t);
  const file = path.join(images, 'chart.png');
  fs.writeFileSync(file, 'original');
  await assert.rejects(run('--mark', '--method', 'exempt'), /--note/);
  await assert.rejects(run('--apply'), /mask\.rects/);
  assert.equal(fs.existsSync(ledger), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
});

test('a restored Windows evidence directory retains its spelling for masking and summary verification', async t => {
  const { dir, images, ledger, run } = fixture(t);
  const restored = path.join(dir, 'EVIDENCE');
  // The intermediate name allows case-only renames on Windows and macOS.
  fs.renameSync(images, images + '-temp');
  fs.renameSync(images + '-temp', restored);
  const file = 'EVIDENCE/舊.png';
  fs.writeFileSync(path.join(dir, file), 'fixture');
  assert.deepEqual((await run('--status')).unmasked, [file]);
  const record = { sha256: sha256File(path.join(dir, file)), method: 'css' };
  fs.writeFileSync(ledger, JSON.stringify({ files: { 'evidence/舊.png': record } }));
  assert.equal((await run('--status')).masked, 1);
  assert.doesNotThrow(() => evidenceChecker(dir)('evidence/舊.png', true));
  assert.deepEqual((await run('--mark', '--method', 'css')).marked, [file]);
  assert.equal(JSON.parse(fs.readFileSync(ledger)).files[file].method, 'css');
  const check = evidenceChecker(dir);
  assert.doesNotThrow(() => check(file, true));
});

// A black two-pixel, single-row, uncompressed 24-bit BMP.
function bmp() {
  const data = Buffer.alloc(62);
  data.write('BM');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(2, 18);
  data.writeInt32LE(1, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(8, 34);
  return data;
}

test('rectangle masking clips to image bounds and refuses to certify invisible or empty masks', {
  skip: process.platform !== 'win32',
}, async t => {
  const { dir, images, ledger, run } = fixture(t);
  const file = path.join(images, '截圖.bmp');
  fs.writeFileSync(file, bmp());
  const config = path.join(path.dirname(dir), 'config.json');
  const rule = { name: 'hide', glob: '*.bmp', rect: [1, -2, 10, 2], color: '#00ff00' };
  const saveRule = change => fs.writeFileSync(config, JSON.stringify({ mask: { rects: [{ ...rule, ...change }] } }));
  saveRule({});
  assert.deepEqual((await run('--apply')).applied, ['evidence/截圖.bmp']);
  const pixels = fs.readFileSync(file);
  const offset = pixels.readUInt32LE(10);
  const stride = pixels.readUInt16LE(28) / 8;
  assert.deepEqual([...pixels.subarray(offset, offset + 3)], [0, 0, 0]);
  assert.deepEqual([...pixels.subarray(offset + stride, offset + stride + 3)], [0, 255, 0]);
  const previous = fs.readFileSync(ledger);
  assert.equal(JSON.parse(previous).files['evidence/截圖.bmp'].sha256, sha256File(file));
  assert.deepEqual((await run('--apply')).skippedAlreadyMasked, ['evidence/截圖.bmp']);
  saveRule({ rect: [9, 9, 10, 10] });
  await assert.rejects(run('--apply', '--force'), /covers no pixels/);
  saveRule({ color: 'Transparent' });
  await assert.rejects(run('--apply', '--force'), /opaque/);
  assert.deepEqual(fs.readFileSync(file), pixels);
  assert.deepEqual(fs.readFileSync(ledger), previous);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['evidence', 'masking.json']);
});
