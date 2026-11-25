import { parseArgs } from 'node:util';
import { changedPaths, commit, repoRoot } from './git-changes.mjs';
import { lint } from './module-lint.mjs';
import { moduleIndex, findImpact } from './module-index.mjs';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const repoOption = { type: 'string', default: '.' };

export function qualityPlan(args) {
  const { values: v } = parseArgs({ args, options: {
    repo: repoOption, base: string, 'review-risk': { type: 'string', default: 'HIGH' },
    'review-reason': string, 'static-passed': boolean, 'impact-complete': boolean, issue: string, full: boolean,
    'impact-scenario': { type: 'string', multiple: true },
  } });
  console.log(JSON.stringify(buildQualityPlan(v)));
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

export function buildQualityPlan(v) {
  const risk = v['review-risk'].toUpperCase();
  const staticPassed = Boolean(v['static-passed']);
  if (!v.base || !v['review-reason']) throw new Error('--base 與 --review-reason 為必填');
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(risk)) throw new Error('無效的 --review-risk');
  if (v.issue !== undefined && !/^\d+$/.test(v.issue)) throw new Error('--issue 須為數字');
  const repo = repoRoot(v.repo);
  const head = commit(repo, 'HEAD');
  const base = commit(repo, v.base);
  const paths = changedPaths(repo, base, head, true);
  const index = moduleIndex(repo, { hashFeatures: true });
  const problems = lint(index);
  const impact = findImpact(index.modules, paths);
  const affected = new Set(impact.modules.map(m => m.name));
  const scope = problems.length ? [] : scenarioImpact(v['impact-scenario'], impact.modules, index, paths);
  const mappedFeatures = new Set(scope.filter(s => s.mappings.length).flatMap(s => s.changedFeatures));
  const docsOnly = paths.every(p => /^(README\.md|docs\/[\p{L}\p{M}\p{N}\p{Pc}/.-]+\.md)$/u.test(p));
  const reviewedFeatures = new Set();
  if (v.issue) {
    for (const m of index.modules.filter(m => affected.has(m.name))) {
      for (const f of m.features()) reviewedFeatures.add(f.feature);
    }
  }
  const requiresFull = paths.some(p => p.startsWith('.bdd/') && !mappedFeatures.has(p) &&
    !(/^\.bdd\/modules\/[^/]+\/[^/]+\/[^/]+\.feature$/.test(p) && reviewedFeatures.has(p)));
  let level = 'FULL';
  let reason = '高風險、要求完整驗證或無法可靠界定影響範圍';
  if (!v.full && risk !== 'HIGH' && !problems.length) {
    if (risk === 'LOW' && staticPassed && docsOnly) {
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
  for (const m of index.modules) {
    if (level === 'FAST' || (level === 'TARGETED' && !affected.has(m.name))) continue;
    const features = m.features();
    const scenarios = features.flatMap(f => f.scenarios);
    const issueTag = '@#' + v.issue;
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
    else if (selected.length) bddStatus = 'PENDING';
  }
  return { head, base, paths, risk: v['review-risk'], reviewReason: v['review-reason'],
    staticPassed, level, reason, unmatched: impact.unmatched, lint: problems, selected, bddStatus,
    ...(v['impact-scenario'] && { scenarioImpact: scope }) };
}
