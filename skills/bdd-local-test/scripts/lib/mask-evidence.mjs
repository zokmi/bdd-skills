import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { readBddOutputConfig } from './bdd-output-config.mjs';
import { evidenceFolder, isEvidenceImage, maskRecord, readMaskLedger, setMaskRecord, sha256File, updateMaskLedger } from './mask-ledger.mjs';
import { artifact, wildcard } from './summary-evidence.mjs';
import { compileWindowsTool } from './windows-compiler.mjs';

const run = promisify(execFile);
let renderer;

const evidenceFile = (dir, relative) => artifact(dir, relative, true);

function listImages(dir) {
  const files = [];
  function visit(relative) {
    const entry = path.join(dir, relative);
    const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('Linked evidence not accepted: ' + relative);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry).sort()) visit(relative + '/' + name);
    } else if (stat.isFile() && isEvidenceImage(relative)) files.push(relative);
  }
  const folder = evidenceFolder(dir);
  if (folder) visit(folder);
  return files;
}

function state(dir, relative, record) {
  if (!record) return 'unmasked';
  return typeof record.sha256 === 'string' && record.sha256.toUpperCase() === sha256File(evidenceFile(dir, relative)) ? 'masked' : 'stale';
}

function matches(pattern, relative) {
  return pattern.test(path.posix.basename(relative)) || pattern.test(relative);
}

function recordedAt(now) {
  const offset = -now.getTimezoneOffset();
  const local = new Date(now.getTime() + offset * 60000).toISOString().slice(0, 19);
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return local + (offset < 0 ? '-' : '+') + hours + ':' + minutes;
}

function rulesFor(dir) {
  const rects = readBddOutputConfig(dir)?.mask?.rects;
  if (!rects || (Array.isArray(rects) && !rects.length)) throw new Error('.bdd/config.json 沒有 mask.rects 規則可套用');
  return [rects].flat().map(rule => {
    if (typeof rule?.glob !== 'string' || !rule.glob || !Array.isArray(rule.rect) || rule.rect.length !== 4 ||
        !rule.rect.every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)) {
      throw new Error('mask.rects 規則需要 glob 與四個整數座標');
    }
    return { name: rule.name ?? rule.glob, glob: wildcard(rule.glob, true), rect: rule.rect, color: rule.color || '#FFFFFF' };
  });
}

async function apply(dir, images, ledger, opts, at) {
  const rules = rulesFor(dir);
  const jobs = [];
  const skippedAlreadyMasked = [];
  for (const relative of images) {
    const matched = rules.filter(rule => matches(rule.glob, relative));
    if (!matched.length) continue;
    if (!opts.force && state(dir, relative, maskRecord(ledger, relative)) === 'masked') {
      skippedAlreadyMasked.push(relative);
      continue;
    }
    const input = evidenceFile(dir, relative);
    jobs.push({ relative, input, matched, original: sha256File(input) });
  }
  if (jobs.length) {
    renderer ??= compileWindowsTool('mask-rectangles', fileURLToPath(new URL('./mask-rectangles.cs', import.meta.url)),
      ['System.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll']);
    const exe = await renderer;
    const stage = fs.mkdtempSync(path.join(dir, '.bdd-mask-stage-'));
    try {
      const requests = jobs.map((job, i) => ({
        input: job.input, output: path.join(stage, String(i)),
        rules: job.matched.map(({ rect, color }) => ({ rect, color })),
      }));
      const requestFile = path.join(stage, 'jobs.json');
      fs.writeFileSync(requestFile, JSON.stringify(requests), { flag: 'wx', mode: 0o600 });
      await run(exe, [requestFile], { cwd: path.dirname(exe), windowsHide: true });
      // Validate the entire batch before replacing any evidence. Hash the staged
      // output, so a later edit of the published image always invalidates its record.
      for (const job of jobs) {
        if (sha256File(evidenceFile(dir, job.relative)) !== job.original) throw new Error('Evidence changed during masking: ' + job.relative);
      }
      for (const [i, job] of jobs.entries()) {
        const sha256 = sha256File(requests[i].output);
        fs.renameSync(requests[i].output, evidenceFile(dir, job.relative));
        setMaskRecord(ledger, job.relative, {
          method: 'rect', rules: job.matched.map(rule => rule.name), sha256, note: opts.note, at,
        });
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  return { dir, applied: jobs.map(j => j.relative), skippedAlreadyMasked };
}

export async function maskCommand(args) {
  const str = { type: 'string' }, flag = { type: 'boolean' };
  const { values: opts } = parseArgs({ args, options: {
    dir: str, status: flag, mark: flag, apply: flag, force: flag,
    pattern: { type: 'string', default: '*' }, method: str, note: { type: 'string', default: '' },
  } });
  if (!opts.dir || [opts.mark, opts.apply, opts.status].filter(Boolean).length !== 1) {
    throw new Error('請指定 --dir，並擇一指定 --status、--apply 或 --mark');
  }
  const dir = path.resolve(opts.dir);
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error('BDD 輸出目錄不存在或是連結：' + dir);
  const method = opts.method?.toLowerCase();
  if (opts.method !== undefined && !['css', 'exempt'].includes(method)) throw new Error('--method 僅接受 css 或 exempt');
  let result;
  if (opts.status) {
    const ledger = readMaskLedger(dir);
    const files = listImages(dir).map(file => {
      const record = maskRecord(ledger, file);
      return { file, state: state(dir, file, record), method: record?.method ?? null };
    });
    const unmasked = files.filter(row => row.state !== 'masked').map(row => row.file);
    result = { dir, total: files.length, masked: files.length - unmasked.length, unmasked, files };
  } else {
    if (opts.mark && !method) throw new Error('--mark 需要 --method css 或 exempt');
    if (opts.mark && method === 'exempt' && !opts.note.trim()) throw new Error('exempt 必須以 --note 寫明為何不需遮罩');
    result = await updateMaskLedger(dir, ledger => {
      const images = listImages(dir);
      const at = recordedAt(new Date());
      if (opts.apply) return apply(dir, images, ledger, opts, at);
      const pattern = wildcard(opts.pattern, true);
      const marked = images.filter(file => matches(pattern, file));
      if (!marked.length) throw new Error('沒有圖片符合 ' + opts.pattern);
      for (const file of marked) {
        setMaskRecord(ledger, file, { method, sha256: sha256File(evidenceFile(dir, file)), note: opts.note, at });
      }
      return { dir, method, marked };
    });
  }
  console.log(JSON.stringify(result));
  return 0;
}
