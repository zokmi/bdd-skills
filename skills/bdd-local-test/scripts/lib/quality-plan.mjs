import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captureApprovedRevision } from './approved-revision.mjs';
import { validateEngineeringChecks } from './engineering-checks.mjs';
import { readGitBlobs } from './git-blobs.mjs';
import { changedPaths, commit, repoRoot } from './git-changes.mjs';
import { lint } from './module-lint.mjs';
import { moduleIndex, findImpact, parseFeature, reviewableScenarios } from './module-index.mjs';
import { git, treeEntriesAt } from './verification-git.mjs';
import { previousWorktreeChanges } from './worktree-snapshot.mjs';
import { resolveNewOutput, writeNewFile } from './write-new-file.mjs';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const sha256Of = content => createHash('sha256').update(content).digest('hex');

function savePlan({ file, staged }, plan) {
  const content = JSON.stringify(plan, null, 2) + '\n';
  writeNewFile(file, content, 0o600, staged);
  return sha256Of(content);
}

function compactPlan(plan) {
  // Tagged rows derive both lists from their tags. A dangling tag row has only IDs.
  const compactRow = row => {
    if (!row.tags) return row;
    const { ids, methods, ...rest } = row;
    return rest;
  };
  const selected = plan.selected.map(({ reason, scenarios, unindexedScenarios, ...feature }) => ({
    ...feature, scenarios: scenarios.map(compactRow),
    ...(unindexedScenarios && { unindexedScenarios: unindexedScenarios.map(compactRow) }),
    ...(reason !== plan.reason && { reason }),
  }));
  return { ...plan, selected };
}

function preview(plan, output) {
  const sha256 = savePlan(output, plan);
  const { head, level, bddStatus, reason, staticPassed, selected } = plan;
  return {
    previewPath: output.file, sha256, head, level, bddStatus, reason, staticPassed,
    counts: {
      paths: plan.paths.length, features: selected.length,
      indexedScenarios: selected.reduce((sum, feature) => sum + feature.scenarios.length, 0),
      engineeringChecks: plan.engineeringChecks?.length ?? 0, lint: plan.lint.length,
      blockers: plan.blockers?.length ?? 0, unmatched: plan.unmatched.length,
    },
    features: selected.map(f => f.feature),
    requiresFullFeature: selected.filter(f => f.requiresFullFeature).map(f => f.feature),
  };
}

function readPreview(v) {
  const allowed = ['read-preview', 'sha256', 'feature'];
  if (!v['read-preview']?.trim() || !/^[a-f\d]{64}$/i.test(v.sha256 ?? '') ||
      (v.feature !== undefined && !v.feature.trim()) || Object.keys(v).some(key => !allowed.includes(key))) {
    throw new Error('請單獨使用 --read-preview <檔案> --sha256 <回執雜湊>，可搭配 --feature <路徑>');
  }
  const bytes = fs.readFileSync(v['read-preview']);
  if (sha256Of(bytes) !== v.sha256.toLowerCase()) throw new Error('預覽檔 SHA-256 與回執不同');
  const plan = JSON.parse(bytes);
  if (!Array.isArray(plan?.selected) || !Array.isArray(plan.lint) || !Array.isArray(plan.unmatched) ||
      !['BLOCKED', 'SKIPPED', 'PENDING'].includes(plan.bddStatus)) throw new Error('無效的選測預覽檔');
  if (v.feature !== undefined) {
    const selected = plan.selected.find(f => f.feature === v.feature);
    if (!selected) throw new Error('計畫未選入指定 Feature：' + v.feature);
    return selected;
  }
  const { bddStatus, staticPassed, lint, unmatched, blockers = [] } = plan;
  return { bddStatus, staticPassed, lint, unmatched, blockers };
}

export function qualityPlan(args) {
  const { values: v } = parseArgs({ args, options: {
    repo: string, base: string, 'previous-verification': string, 'review-risk': string, 'issue-scope': string,
    output: string, 'run-id': string, 'engineering-checks': string, compact: boolean, 'preview-output': string,
    'read-preview': string, sha256: string, feature: string,
    'review-reason': string, 'static-passed': boolean, 'impact-complete': boolean, issue: string, full: boolean,
    'impact-scenario': { type: 'string', multiple: true }, 'batch-path': { type: 'string', multiple: true },
  } });
  if (v['read-preview'] !== undefined || v.sha256 !== undefined || v.feature !== undefined) {
    console.log(JSON.stringify(readPreview(v)));
    return 0;
  }
  v.repo ??= '.';
  const batchOutput = v.output !== undefined || v['run-id'] !== undefined;
  const previewFile = v['preview-output'];
  if ((v.compact && previewFile !== undefined) || (batchOutput && (v.compact || previewFile !== undefined))) {
    throw new Error('--compact、--preview-output 與批次 --output/--run-id 須分開使用');
  }
  if (!batchOutput) {
    const context = planContext(v);
    const plan = selectPlan(v, context);
    let result = plan;
    if (v.compact) result = compactPlan(plan);
    if (previewFile !== undefined) {
      result = preview(plan, resolveNewOutput([context.repo], previewFile, '--preview-output'));
    }
    console.log(JSON.stringify(result));
    return 0;
  }
  if (!v.output?.trim() || !v['run-id']?.trim() || !v.issue || (v['issue-scope'] ?? 'batch') !== 'batch') {
    throw new Error('批次選測存檔須搭配 --issue、--run-id 與 --output');
  }
  const repo = fs.realpathSync.native(repoRoot(v.repo));
  const output = resolveNewOutput([repo], v.output, '--output');
  const revision = captureApprovedRevision(repo);
  const plan = selectPlan(v, planContext(v, repo));
  if (plan.bddStatus !== 'PENDING') {
    throw new Error('無法建立派工選測檔：' + plan.bddStatus + ' ' + [...(plan.blockers ?? []), ...plan.lint.map(p => p.message)].join('；'));
  }
  for (const feature of plan.selected.filter(f => f.requiresFullFeature)) {
    if (feature.unterminatedDocString || !feature.unindexedScenarios?.length ||
        feature.unindexedScenarios.some(row => row.unattached || row.ids.length !== 1)) {
      throw new Error('請先確認可派工的完整情境編號：' + feature.feature);
    }
    feature.scenarios = reviewableScenarios(feature);
  }
  const after = captureApprovedRevision(repo);
  if (revision.head !== plan.head || revision.head !== after.head || revision.dirtySha256 !== after.dirtySha256) {
    throw new Error('建立選測檔期間候選版本已變更，請重新選測');
  }
  const sha256 = savePlan(output, { ...plan, repo, runId: v['run-id'], revision });
  console.log(JSON.stringify({ path: output.file, sha256 }));
  return 0;
}

function scenarioImpact(entries, affectedModules, index, paths) {
  if (!entries?.length) return [];
  const byName = new Map(index.modules.map(m => [m.name, m]));
  const scopes = affectedModules.map(({ name, files }) => {
    const features = byName.get(name).features();
    return { module: name, files, features, mappings: [] };
  });
  for (const entry of new Set(entries)) {
    const separator = entry.lastIndexOf('=');
    const file = entry.slice(0, separator).replaceAll('\\', '/');
    const id = entry.slice(separator + 1);
    const owner = scopes.find(s => s.files.includes(file) &&
      s.features.some(f => f.scenarios.some(row => row.ids.includes(id)) || f.unindexedScenarios?.some(row => row.ids.includes(id))));
    if (separator < 1 || !owner) {
      throw new Error('--impact-scenario 需要實際異動路徑與該路徑對應模組內的情境編號：' + entry);
    }
    owner.mappings.push({ path: file, id });
  }
  const changed = new Set(paths);
  return scopes.map(({ module, files, features, mappings }) => {
    mappings.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
    const mappedPaths = new Set(mappings.map(row => row.path));
    const unmappedPaths = files.filter(file => !mappedPaths.has(file));
    const changedFeatures = features.map(f => f.feature).filter(file => changed.has(file));
    const incompleteFeatures = features.filter(f => f.requiresFullFeature).map(f => f.feature);
    let reason = '所有受影響來源已有情境映射，保留映射情境、@core、@P0 與本單情境';
    let selection = 'mapped';
    if (unmappedPaths.length || changedFeatures.length || incompleteFeatures.length) {
      selection = 'module';
      reason = '變更來源未完整映射、情境文件有異動或索引不完整，保留整個模組；不完整的 Feature 依全文派工';
    }
    return { module, selection, reason, mappings, unmappedPaths, changedFeatures, incompleteFeatures };
  });
}

const isDocumentation = p => /^(README\.md|docs\/[\p{L}\p{M}\p{N}\p{Pc}/.-]+\.md)$/u.test(p);

function batchChangedPaths(repo, base, head) {
  // At HEAD the staged intersection is just the full set of staged paths.
  if (base === head) return changedPaths(repo, base, head);
  const paths = args => git(repo, args).split('\0').filter(Boolean);
  const diff = ['diff', '--no-renames', '--name-only', '-z'];
  const changed = new Set(paths([...diff, base, '--']));
  const staged = paths([...diff, '--cached', head, '--']);
  if (staged.length) {
    // A saved feedback snapshot can differ from HEAD even when the index is untouched.
    const differsFromBase = new Set(paths([...diff, '--cached', base, '--']));
    for (const p of staged) if (differsFromBase.has(p)) changed.add(p);
  }
  for (const p of paths(['ls-files', '-z', '--others', '--exclude-standard'])) changed.add(p);
  return [...changed].sort((a, b) => a.localeCompare(b));
}

function tagStart(lines, headingLine) {
  let start = headingLine - 1;
  while (start && /^(?:\s*$|\s*[@#])/.test(lines[start - 1])) start--;
  return start;
}

// Include the tags preceding a heading and the steps/examples following it.
// Shared declarations and removed IDs need an explicit decision about coverage.
function scenarioSections(text, feature) {
  if (feature.requiresFullFeature) return null;
  const lines = text.split(/\r\n?|\n/);
  const starts = feature.scenarios.map(row => tagStart(lines, row.line));
  const sections = new Map();
  for (const [i, row] of feature.scenarios.entries()) {
    if (row.ids.length !== 1 || sections.has(row.ids[0])) return null;
    const block = lines.slice(starts[i], starts[i + 1]).join('\n').trimEnd();
    if (/^\s*(?:Rule|Background|規則|规则|背景)\s*[:：]/mi.test(block)) return null;
    sections.set(row.ids[0], block);
  }
  const header = lines.slice(0, starts[0]).join('\n').trimEnd();
  return { header, sections };
}

function changedScenarioIds(feature, originalBytes, currentBytes) {
  if (!originalBytes) return { ids: feature.scenarios.flatMap(s => s.ids), needsMapping: Boolean(feature.requiresFullFeature) };
  const previousText = originalBytes.toString('utf8');
  const before = scenarioSections(previousText, parseFeature(previousText, feature.feature));
  const after = scenarioSections(currentBytes.toString('utf8'), feature);
  if (!before || !after) return { ids: [], needsMapping: true };
  const ids = [...after.sections.keys()].filter(id => after.sections.get(id) !== before.sections.get(id));
  const removed = [...before.sections.keys()].some(id => !after.sections.has(id));
  return { ids, needsMapping: before.header !== after.header || removed };
}

function feedbackPlan(repo, opts, index, result, currentSources) {
  const reason = '只選取本批新增、修改的情境，以及已核對的來源與相依回歸映射';
  if (result.lint.length) return { ...result, level: 'TARGETED', reason, selected: [], bddStatus: 'BLOCKED',
    blockers: ['修正 lint 所列的模組與情境問題後重新選測'], batchMappings: [] };
  const blockers = [];
  const selectedIds = new Set();
  const changed = new Set(result.paths);
  const checks = result.engineeringChecks ?? [];
  const mappedPaths = new Set(checks.map(check => check.path));
  const mappings = [];
  const features = new Map();
  const scenarioById = new Map();
  const entries = new Set(opts['impact-scenario']);
  const prefixes = new Set([...entries].map(entry => entry.slice(entry.lastIndexOf('=') + 1).split('-')[0]));
  const directories = new Set(result.paths.filter(p => /\.feature$/i.test(p)).map(p => path.posix.dirname(p)));
  for (const mod of index.modules) {
    if (!prefixes.has(mod.prefix) && !directories.has(path.posix.join('.bdd/modules', mod.name))) continue;
    for (const f of mod.features()) {
      const scenarios = reviewableScenarios(f);
      features.set(f.feature, { module: mod.name, feature: f, rows: scenarios });
      for (const s of scenarios) for (const id of s.ids) scenarioById.set(id, scenarioById.has(id) ? null : f);
    }
  }
  for (const entry of entries) {
    const separator = entry.lastIndexOf('=');
    const file = entry.slice(0, separator).replaceAll('\\', '/');
    const id = entry.slice(separator + 1);
    if (separator < 1 || !changed.has(file) || !scenarioById.get(id)) {
      throw new Error('--impact-scenario 需要本批的異動路徑與可辨識的現行情境編號：' + entry);
    }
    mappings.push({ path: file, id });
    mappedPaths.add(file);
    selectedIds.add(id);
  }
  const changedFeatures = result.paths.filter(p => features.has(p));
  const requiredMappings = new Set(result.paths.filter(p => !isDocumentation(p) && (result.batchPaths !== undefined || !features.has(p))));
  if (!result.batchPaths && changedFeatures.length) {
    const { blobs, modes, sizes } = treeEntriesAt(repo, result.base, changedFeatures, { includeSizes: true });
    const regular = new Set(['100644', '100755']);
    const oldFiles = changedFeatures.filter(file => regular.has(modes[file]));
    const oldBlobs = readGitBlobs(repo, oldFiles.map(file => ({ oid: blobs[file], size: sizes[file] })));
    for (const file of changedFeatures) {
      if (modes[file] && !regular.has(modes[file])) {
        requiredMappings.add(file);
        continue;
      }
      const originalBytes = blobs[file] ? oldBlobs.next().value.bytes : null;
      const delta = changedScenarioIds(features.get(file).feature, originalBytes, currentSources.get(file));
      for (const id of delta.ids) selectedIds.add(id);
      if (delta.needsMapping) requiredMappings.add(file);
    }
  }
  const unmapped = [...requiredMappings].filter(p => !mappedPaths.has(p));
  if (unmapped.length) blockers.push('以 --impact-scenario "異動路徑=情境編號" 補上受影響情境與相依回歸，純工程異動可用 --engineering-checks：' + unmapped.join('、'));
  if (!opts['impact-complete']) blockers.push('核對本批差異與外溢依賴後加上 --impact-complete');
  if (!result.staticPassed) blockers.push('完成並通過本批靜態檢查後加上 --static-passed');
  if (!result.paths.length) blockers.push('本批沒有異動，請核對 --base 是否為本次回饋修改前的版本');
  else if (!selectedIds.size && !checks.length && !unmapped.length) blockers.push('本批尚無可執行項目，請提供適用的 --impact-scenario 或 --engineering-checks');
  const selected = [];
  for (const { module, feature, rows } of features.values()) {
    const scenarios = rows.filter(s => s.ids.some(id => selectedIds.has(id)));
    if (scenarios.length) selected.push({ module, feature: feature.feature, sha256: feature.sha256, scenarios, reason });
  }
  return { ...result, level: 'TARGETED', reason, selected, bddStatus: blockers.length ? 'BLOCKED' : 'PENDING',
    blockers, batchMappings: mappings };
}

function planContext(v, repo) {
  const issueScope = v['issue-scope'] ?? (v.issue !== undefined ? 'batch' : undefined);
  if (issueScope !== undefined && (v.issue === undefined || !['batch', 'issue'].includes(issueScope))) {
    throw new Error('--issue-scope batch 或 issue 須與 --issue 一起使用');
  }
  if (v['batch-path'] && issueScope !== 'batch') throw new Error('--batch-path 適用於 --issue 的本批選測');
  if (v['engineering-checks'] !== undefined && issueScope !== 'batch') throw new Error('--engineering-checks 適用於 --issue 的本批選測');
  const risk = (v['review-risk'] ?? (issueScope ? 'MEDIUM' : 'HIGH')).toUpperCase();
  const staticPassed = Boolean(v['static-passed']);
  const previous = v['previous-verification'];
  if (previous && issueScope !== 'batch') throw new Error('--previous-verification 適用於同單的本批選測');
  if (Boolean(v.base) === Boolean(previous) || !v['review-reason']) {
    throw new Error('請擇一提供 --base 或 --previous-verification，並提供 --review-reason');
  }
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(risk)) throw new Error('無效的 --review-risk');
  if (v.issue !== undefined && !/^\d+$/.test(v.issue)) throw new Error('--issue 須為數字');
  return { repo: repo ?? repoRoot(v.repo), issueScope, risk, staticPassed, previous };
}

export function buildQualityPlan(v) {
  return selectPlan(v, planContext(v));
}

function selectPlan(v, { repo, issueScope, risk, staticPassed, previous }) {
  const head = commit(repo, 'HEAD');
  const snapshot = previous ? previousWorktreeChanges(repo, head, previous, v.issue) : null;
  const base = snapshot?.base ?? (v.base === 'HEAD' ? head : commit(repo, v.base));
  const allPaths = snapshot?.paths ?? (issueScope === 'batch' ? batchChangedPaths(repo, base, head) : changedPaths(repo, base, head));
  let batchPaths;
  if (v['batch-path']) {
    const requested = new Set(v['batch-path'].map(p => p.replaceAll('\\', '/').replace(/^\.\//, '')));
    batchPaths = allPaths.filter(p => requested.has(p));
    if (!batchPaths.length || batchPaths.length !== requested.size) {
      throw new Error('--batch-path 須指定 Git 差異中實際變更的路徑：' + [...requested].filter(p => !batchPaths.includes(p)).join('、'));
    }
  }
  const paths = batchPaths && !v.full && risk !== 'HIGH' ? batchPaths : allPaths;
  const checks = v['engineering-checks'] === undefined ? undefined : validateEngineeringChecks(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(v['engineering-checks']))), paths);
  const compareFeatures = issueScope === 'batch' && !batchPaths && ((!v.full && risk !== 'HIGH') || checks);
  const currentSources = compareFeatures ? new Map(paths.filter(p => /\.feature$/i.test(p)).map(p => [p, null])) : undefined;
  const index = moduleIndex(repo, { hashFeatures: true, retainedSources: currentSources });
  const problems = lint(index);
  const impact = findImpact(index.modules, paths);
  const result = { head, base, ...(snapshot && { baseHead: snapshot.baseHead }), paths, risk: v['review-risk'] ?? risk, reviewReason: v['review-reason'],
    staticPassed, unmatched: impact.unmatched, lint: problems, ...(issueScope && { issue: v.issue, issueScope }),
    ...(batchPaths && { batchPaths, allChangedPaths: allPaths }), ...(checks && { engineeringChecks: checks }) };
  const docsOnly = paths.every(isDocumentation);
  const fast = risk === 'LOW' && staticPassed && docsOnly && !checks;
  if (issueScope === 'batch' && !v.full && risk !== 'HIGH' && !(fast && !problems.length && paths.length)) {
    return feedbackPlan(repo, v, index, result, currentSources);
  }
  const affected = new Set(impact.modules.map(m => m.name));
  const scope = problems.length || issueScope === 'batch' ? [] : scenarioImpact(v['impact-scenario'], impact.modules, index, paths);
  const mappedFeatures = new Set(scope.filter(s => s.mappings.length).flatMap(s => s.changedFeatures));
  const reviewedFeatures = new Set();
  if (v.issue) {
    for (const m of index.modules.filter(m => affected.has(m.name))) {
      for (const f of m.features()) reviewedFeatures.add(f.feature);
    }
  }
  const requiresFull = paths.some(p => p.startsWith('.bdd/') && !mappedFeatures.has(p) && !reviewedFeatures.has(p));
  let level = 'FULL';
  let reason = '高風險、要求完整驗證或無法可靠界定影響範圍';
  if (!v.full && risk !== 'HIGH' && !problems.length) {
    if (issueScope === 'issue' && docsOnly) {
      level = 'TARGETED';
      reason = '整單檢查，從所有模組選取本單情境';
    } else if (fast) {
      level = 'FAST';
      reason = '靜態檢查通過且 Review 確認文件異動不影響行為';
    } else if (v['impact-complete'] && affected.size && !impact.unmatched.length && !requiresFull) {
      level = 'TARGETED';
      reason = '所有異動已對應模組，Review 已核對外溢依賴';
    }
  }
  if (level !== 'TARGETED') {
    for (const s of scope) {
      s.selection = level;
      s.reason = reason;
    }
  }
  const selected = [];
  const issueTag = '@#' + v.issue;
  for (const m of index.modules) {
    if (level === 'FAST') continue;
    if (level === 'TARGETED' && !affected.has(m.name)) {
      if (issueScope === 'issue') {
        for (const f of m.features()) {
          const scenarios = reviewableScenarios(f).filter(s => s.tags.includes(issueTag));
          if (scenarios.length) selected.push({ module: m.name, feature: f.feature, sha256: f.sha256, scenarios, reason: '整單檢查，選取 ' + issueTag });
        }
      }
      continue;
    }
    const features = m.features();
    const scenarios = features.flatMap(f => f.scenarios);
    const reviewed = scope.find(s => s.module === m.name);
    const byMapping = reviewed?.selection === 'mapped';
    const mappedIds = new Set(reviewed?.mappings.map(row => row.id));
    const byIssue = !reviewed && level === 'TARGETED' && v.issue && features.every(f => !f.requiresFullFeature) &&
      scenarios.some(s => s.tags.includes(issueTag)) && scenarios.some(s => s.tags.includes('@core'));
    for (const f of features) {
      let picked = f.scenarios;
      if (byMapping || byIssue) {
        picked = picked.filter(s => s.tags.includes(issueTag) || s.tags.includes('@core') ||
          (byMapping && (s.tags.includes('@P0') || s.ids.some(id => mappedIds.has(id)))));
        if (!picked.length) continue;
      }
      selected.push({ module: m.name, ...f, scenarios: picked,
        reason: reviewed?.reason ?? (byIssue ? '已核對影響範圍，選取 ' + issueTag + ' 與 @core' : reason) });
    }
  }
  let bddStatus = 'BLOCKED';
  if (staticPassed && !problems.length) {
    if (level === 'FAST') bddStatus = 'SKIPPED';
    else if (selected.length || checks?.length) bddStatus = 'PENDING';
  }
  if (checks) {
    // FULL adds regression scenarios and still needs coverage of the actual engineering batch.
    const batch = feedbackPlan(repo, v, index, result, currentSources);
    return { ...result, level, reason, selected, bddStatus: batch.bddStatus,
      blockers: batch.blockers, batchMappings: batch.batchMappings };
  }
  return { ...result, level, reason, selected, bddStatus,
    ...(issueScope !== 'batch' && v['impact-scenario'] && { scenarioImpact: scope }) };
}
