import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadBddOutputConfig } from './bdd-output-config.mjs';
import { parseMaskLedger, isEvidenceImage, maskRecord } from './mask-ledger.mjs';
import { addSnapshots, deduplicate, fileEntry, hashBytes, sourceFiles } from './archive-pack.mjs';
import { safePathComponent } from './archive-limits.mjs';
import { archiveLocation, repository, storeArchive } from './archive-store.mjs';
import { optimizeImages } from './archive-images.mjs';
import { decodeArchiveText } from './archive-text.mjs';

async function readSource(source) {
  for (const required of ['REPORT.md', 'verification.json']) {
    const stat = await lstat(path.join(source, required)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!stat?.isFile()) throw new Error(`缺少 ${required}，不能封存`);
  }
  let files = await sourceFiles(source);
  const flattened = [];
  const legacy = files.find(file => file.name.toLowerCase() === 'evidence.zip');
  if (legacy) {
    const { expandArchive } = await import('./extract.mjs');
    const result = await expandArchive({ archive: legacy.path, to: source, evidenceZip: true });
    flattened.push(...result.writtenPaths.map(file => path.relative(source, file).split(path.sep).join('/')));
    files = (await sourceFiles(source)).filter(file => file.path !== legacy.path);
  }
  const entries = [];
  const json = new Map();
  for (const file of files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const key = process.platform === 'win32' ? file.name.toLowerCase() : file.name;
    if (key === 'verification.json' || key === 'masking.json') {
      const data = await readFile(file.path);
      json.set(key, decodeArchiveText(data));
      entries.push({ name: file.name, data, sha256: hashBytes(data), size: data.length, mtime: (await lstat(file.path)).mtime, extra: {} });
    } else {
      entries.push(await fileEntry(file.name, file.path));
    }
  }
  const verification = JSON.parse(json.get('verification.json'));
  const last = verification.rounds?.at(-1);
  const scenarios = last?.scenarios ?? [];
  if (!Array.isArray(scenarios)) throw new Error('verification.json 的 scenarios 必須為陣列');
  if (!scenarios.length && !entries.some(e => /\.feature$/i.test(e.name))) throw new Error('缺少情境：沒有 .feature 或受測 scenarios');
  const evidence = entries.filter(e => /^evidence\//i.test(e.name));
  if (!evidence.length) throw new Error('缺少截圖／其他證據檔（evidence/ 為空），不能封存');
  const ledger = parseMaskLedger(json.get('masking.json') ?? '{}');
  const unmasked = evidence.filter(e => isEvidenceImage(e.name) &&
    String(maskRecord(ledger, e.name)?.sha256).toUpperCase() !== e.sha256).map(e => e.name);
  return { entries, ledger, last, scenarios, flattened, legacy, unmasked };
}

export async function archiveCommand(args) {
  const names = ['dir', 'archive-root', 'destination', 'commit', 'issue', 'allow-unmasked-reason'];
  const { values: options } = parseArgs({ args, options: Object.fromEntries(names.map(k => [k, { type: 'string' }])) });
  if (!options.dir) throw new Error('請以 --dir 指定 BDD 輸出目錄');
  const source = path.resolve(options.dir);
  if (!(await lstat(source)).isDirectory()) throw new Error(`BDD 輸出不是一般目錄：${source}`);
  const topic = safePathComponent(path.basename(source));
  const { repo, worktrees } = repository(source);
  const warnings = [];
  const { entries, ledger, last, scenarios, flattened, legacy, unmasked } = await readSource(source);
  const fileCount = entries.length;
  const settings = loadBddOutputConfig(source, worktrees[0]);
  const { config } = settings;
  const setting = String(config.webp ?? 'auto').toLowerCase();
  if (!['auto', 'off'].includes(setting)) throw new Error(`.bdd/config.json 的 webp 只能是 auto 或 off：${setting}`);
  const reason = options['allow-unmasked-reason'];
  if (reason !== undefined && !reason.trim()) throw new Error('--allow-unmasked-reason 必須寫明理由');
  const maskRequired = Boolean(config.mask?.required ?? true);
  if (unmasked.length && maskRequired && !reason) {
    throw new Error(`有 ${unmasked.length} 張圖片沒有有效的遮罩紀錄，不能封存：\n  ${unmasked.slice(0, 20).join('\n  ')}\n請以 node bdd.mjs mask-evidence 套用或登記遮罩`);
  }
  const commit = options.commit || last?.head;
  if (typeof commit !== 'string' || !commit) throw new Error('verification.json 沒有任何輪次的 head，請以 --commit 指定受測 SHA');
  const issue = options.issue || topic.match(/^(\d+)-/)?.[1] || '';
  const location = await archiveLocation({ options, settings, worktrees, topic, commit, issue, warnings });
  const staging = await mkdtemp(path.join(os.tmpdir(), 'bdd-archive-'));
  try {
    await addSnapshots(entries, repo, commit, scenarios, staging);
    const { webp, rewrittenLinks } = await optimizeImages(entries, ledger, setting, staging, warnings);
    const plan = deduplicate(entries);
    const masked = unmasked.length === 0;
    const createdAt = new Date().toISOString();
    const manifest = {
      schema: 2, tool: 'bdd-local-test/bdd.mjs archive', issue, topic, commit,
      features: scenarios.map(s => s.path), createdAt, masked, maskRequired, unmasked,
      unmaskedReason: masked ? null : reason ?? null, flattenedFrom: legacy ? ['evidence.zip'] : [],
      sourceFileCount: fileCount, storedFileCount: plan.stored.length, files: plan.files, webp, rewrittenLinks, aliases: plan.aliases,
    };
    const event = { event: 'created', archive: location.target, name: path.basename(location.target), issue, topic, commit,
      repo: worktrees[0], sourceDir: source, webp: webp.converted > 0, at: createdAt };
    const stored = await storeArchive(location, plan, manifest, event);
    const maxAttachmentBytes = config.maxAttachmentBytes ?? null;
    const exceedsAttachmentLimit = Boolean(maxAttachmentBytes && stored.sizeBytes > maxAttachmentBytes);
    if (!masked) warnings.push(`有 ${unmasked.length} 張圖片未登記遮罩，此封存不可上傳 issue；需要上傳時先遮罩再重新封存`);
    if (exceedsAttachmentLimit) warnings.push(`封存檔 ${stored.sizeBytes} 位元組超過附件上限 ${maxAttachmentBytes}`);
    console.log(JSON.stringify({ source, archive: location.target, archiveRoot: location.root, archiveRootSource: location.rootSource,
      index: location.index, commit, fileCount, storedFileCount: plan.stored.length, aliasCount: Object.keys(plan.aliases).length,
      sourceBytes: entries.reduce((n, e) => n + e.size, 0), ...stored, masked, flattened, maxAttachmentBytes, exceedsAttachmentLimit,
      webpEncoder: webp.encoder, webpConverted: webp.converted, webpSavedBytes: webp.savedBytes, warnings }));
    return 0;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
