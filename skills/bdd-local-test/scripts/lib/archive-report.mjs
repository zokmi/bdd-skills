import path from 'node:path';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import { hashBytes } from './archive-pack.mjs';
import { decodeArchiveText } from './archive-text.mjs';
import { isEvidenceImage } from './mask-ledger.mjs';
import { result as validResult } from './parallel-validators.mjs';
import { markdownAnchors, reportEvidence } from './report-anchors.mjs';
import { pathKey } from './summary-evidence.mjs';

const coordination = /^(?:coordination\/attempt-([1-9]\d*)\/)?(assignment|result)\.json$/i;
const scenarioKey = (feature, id, role) => JSON.stringify([pathKey(feature.replaceAll('\\', '/')), id.toLowerCase(), role]);

export async function readSmallReport(file) {
  const stat = await lstat(file.path, { bigint: true });
  if (!stat.isFile()) throw new Error('來源不是一般檔案：' + file.path);
  if (stat.size > 64n * 1024n) return null;
  // Reading one extra byte detects growth while keeping the single report buffer bounded.
  const bytes = await buffer(createReadStream(file.path, { end: Number(stat.size) }));
  if (bytes.length !== Number(stat.size)) throw new Error('封存時來源已變動：' + file.name);
  const entry = { ...file, size: bytes.length, mtime: stat.mtime, sha256: hashBytes(bytes), extra: {} };
  return { entry, stat, bytes };
}

function requiresScreenshot(description) {
  // Only explicit retention instructions are machine-checkable. A conditional
  // mask or a reference to a previously uploaded attachment permits a text report.
  return description.split(/[。；;\n]/).some(clause => {
    if (!/(?:保留|保存|留存|附上).{0,80}(?:截圖|螢幕擷圖)|(?:retain|save|keep|attach)\b.{0,80}\bscreenshots?\b/i.test(clause)) return false;
    if (/不[必需須用要]|無[需須]|不(?:予|再)?保留|免(?:附|截圖)|必要時|視需要|(?:若|如).{0,30}才|選用|暫存|判讀後.{0,8}刪除|\b(?:optional|if needed|if necessary|do not|no need)\b/i.test(clause)) return false;
    return /本機|\blocal\b/i.test(clause) || !/(?:Redmine|issue).{0,30}(?:附件|attachment|連結)|(?:附件|attachment).{0,30}(?:Redmine|issue)/i.test(clause);
  });
}

async function entryText(entry) {
  const bytes = entry.data ?? await readFile(entry.path);
  if (hashBytes(bytes) !== entry.sha256) throw new Error('封存時來源已變動：' + entry.name);
  return decodeArchiveText(bytes);
}

async function dispatches(entries) {
  const folders = new Map();
  for (const entry of entries) {
    if (/(?:^|\/)groups\/[^/]+\/(?:coordination\/attempt-[1-9]\d*\/)?(?:assignment|result)\.json$/i.test(entry.name)) {
      throw new Error('輸出內含分組派工，請從各組的輸出目錄封存：' + entry.name);
    }
    const match = coordination.exec(entry.name);
    if (!match) continue;
    const folder = match[1] ?? '';
    if (!folders.has(folder)) folders.set(folder, {});
    folders.get(folder)[match[2].toLowerCase()] = entry;
  }
  const attempts = new Map();
  for (const [folder, files] of folders) {
    const plan = files.assignment && JSON.parse(await entryText(files.assignment));
    const record = files.result && JSON.parse(await entryText(files.result));
    if (!folder && ![plan, record].some(item => item?.contractVersion != null || item?.groupId != null)) continue;
    const name = (files.result ?? files.assignment).name;
    const attempt = folder ? Number(folder) : (record ?? plan).attempt;
    if (record && (!validResult(record) || record.attempt !== attempt)) throw new Error('派工結果格式或 attempt 不符：' + name);
    if (plan && record && (['runId', 'groupId', 'attempt'].some(k => plan[k] !== record[k]) ||
        plan.approvedPlan?.sha256 !== record.approvedPlanSha256)) throw new Error('派工與結果身分不符：' + name);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempts.has(attempt)) throw new Error('派工 attempt 重複或無效：' + name);
    attempts.set(attempt, { plan, record, name });
  }
  return attempts;
}

function selectedChecks(round) {
  const selected = new Map();
  for (const scenario of round?.scenarios ?? []) {
    if (!Array.isArray(scenario.ids) || !scenario.ids.length || typeof scenario.path !== 'string') {
      throw new Error('無法由最後輪次的受測情境識別 REPORT.md 證據');
    }
    for (const id of scenario.ids) {
      if (typeof id !== 'string' || !id.trim()) throw new Error('最後輪次缺少情境編號');
      selected.set(scenarioKey(scenario.path, id, scenario.role), id);
    }
  }
  for (const id of round?.engineeringChecks ?? []) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('最後輪次缺少工程檢查編號');
    selected.set(JSON.stringify([id.toLowerCase()]), id);
  }
  if (!selected.size) throw new Error('最後驗證輪次缺少可追溯的情境或工程檢查，不能以 REPORT.md 封存');
  return selected;
}

export async function verifyReportEvidence(entries, ledger, rounds, smallReport) {
  const selected = selectedChecks(rounds?.at(-1));
  const inventory = new Map(entries.map(entry => [pathKey(entry.name), entry]));
  function required(name) {
    if (typeof name !== 'string' || !name) throw new Error('缺少本機報告或證據引用');
    const relative = path.posix.normalize(name.replaceAll('\\', '/'));
    const entry = inventory.get(pathKey(relative));
    if (!entry || path.win32.isAbsolute(name) || name.includes(':')) throw new Error('封存缺少引用的本機證據：' + name);
    return entry;
  }

  for (const name of Object.keys(ledger.files)) required(name);
  const image = entries.find(entry => isEvidenceImage(entry.name));
  if (image) throw new Error('圖片須放在 evidence/ 並核對遮罩：' + image.name);
  const report = required('REPORT.md');
  let text;
  if (smallReport?.entry === report) {
    const before = smallReport.stat, now = await lstat(report.path, { bigint: true });
    if (now.isFile() && now.dev === before.dev && now.ino === before.ino && now.size === before.size &&
        now.mtimeNs === before.mtimeNs && now.ctimeNs === before.ctimeNs) text = decodeArchiveText(smallReport.bytes);
  }
  const { populated, attachments } = reportEvidence(text ?? await entryText(report));
  for (const name of attachments) required(name);
  const anchors = new Map();
  async function checkReference(reference) {
    const hash = reference.indexOf('#');
    const entry = required(hash < 0 ? reference : reference.slice(0, hash));
    if (hash < 0 || !/\.(?:md|markdown)$/i.test(entry.name)) return false;
    const section = decodeURIComponent(reference.slice(hash + 1));
    if (entry === report) {
      if (!populated.has(section)) throw new Error('REPORT.md 缺少有內容的證據段落：' + reference);
      return true;
    }
    if (!anchors.has(entry)) anchors.set(entry, markdownAnchors(await entryText(entry)));
    if (!anchors.get(entry).has(section)) throw new Error('證據段落不存在：' + reference);
    return false;
  }

  const named = new Set();
  const ids = new Map();
  let longestId = 0;
  for (const value of selected.values()) {
    const id = value.toLowerCase();
    ids.set(id, (ids.get(id) ?? 0) + 1);
    longestId = Math.max(longestId, id.length);
  }
  for (const section of populated) {
    // A titled scenario heading has the ID followed by its Markdown slug separator.
    const title = section.toLowerCase();
    const prefixEnd = title.length <= longestId ? title.length : title.lastIndexOf('-', longestId);
    if (prefixEnd < 0) continue;
    const parts = title.slice(0, prefixEnd).split('-');
    while (parts.length) {
      const prefix = parts.join('-');
      if (ids.has(prefix)) {
        if (ids.get(prefix) === 1) named.add(prefix);
        break;
      }
      parts.pop();
    }
  }
  const results = new Set(), attempts = await dispatches(entries);
  const latestAttempt = Math.max(...attempts.keys());
  for (const [attempt, { plan, record, name }] of attempts) {
    const current = attempt === latestAttempt;
    if (!record) {
      if (current) throw new Error('缺少本次派工的 result.json：' + name);
      continue;
    }
    const pointer = record.verification;
    if (pointer && (required(pointer.path) !== required('verification.json') || pointer.roundIndex >= rounds.length)) {
      throw new Error('派工 result.json 的 verification 輪次無效：' + name);
    }
    if (current && pointer?.roundIndex !== rounds.length - 1) throw new Error('最新派工未指向最後驗證輪次：' + name);
    if ((current || record.artifacts.report) && required(record.artifacts.report) !== report) {
      throw new Error('派工報告並非 REPORT.md：' + name);
    }
    if (record.artifacts.masking) required(record.artifacts.masking);
    if (plan && current) {
      const assertions = [...(plan.scenarios ?? []).flatMap(s => s.assertions ?? []), ...(plan.engineeringChecks ?? [])];
      for (const assertion of assertions) {
        if (typeof assertion.evidence !== 'string') continue;
        for (const name of reportEvidence(assertion.evidence).attachments) required(name);
        if (/^(?:\.\/)?evidence[\\/]/i.test(assertion.evidence)) required(assertion.evidence);
        if (requiresScreenshot(assertion.evidence)) throw new Error('派工指定保留截圖，evidence/ 缺少本機圖片：' + assertion.evidence);
      }
    }
    for (const row of [...record.scenarios, ...(record.engineeringChecks ?? [])]) {
      let linked = false;
      for (const ref of row.evidence) if (await checkReference(ref)) linked = true;
      if (!current) continue;
      const key = row.feature ? scenarioKey(row.feature, row.id, row.kind) : JSON.stringify([row.id.toLowerCase()]);
      if (!selected.has(key) || results.has(key)) throw new Error('派工項目與最後驗證輪次不符：' + row.id);
      if (!linked && !named.has(row.id.toLowerCase())) throw new Error('REPORT.md 缺少可追溯的實測段落：' + row.id);
      results.add(key);
    }
  }
  for (const [key, id] of selected) {
    if (attempts.size ? !results.has(key) : !named.has(id.toLowerCase())) {
      throw new Error('最後驗證輪次缺少可追溯的 REPORT.md 段落：' + id);
    }
  }
}
