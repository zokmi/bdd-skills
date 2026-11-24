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
  } });
  console.log(JSON.stringify(buildQualityPlan(v)));
  return 0;
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
  const docsOnly = paths.every(p => /^(README\.md|docs\/[\p{L}\p{M}\p{N}\p{Pc}/.-]+\.md)$/u.test(p));
  const reviewedFeatures = new Set();
  if (v.issue) {
    for (const m of index.modules.filter(m => affected.has(m.name))) {
      for (const f of m.features()) reviewedFeatures.add(f.feature);
    }
  }
  const requiresFull = paths.some(p => p.startsWith('.bdd/') &&
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
  const selected = [];
  for (const m of index.modules) {
    if (level === 'FAST' || (level === 'TARGETED' && !affected.has(m.name))) continue;
    const features = m.features();
    const scenarios = features.flatMap(f => f.scenarios);
    const issueTag = '@#' + v.issue;
    const narrow = level === 'TARGETED' && v.issue && features.every(f => f.scenarios.length) &&
      scenarios.some(s => s.tags.includes(issueTag)) && scenarios.some(s => s.tags.includes('@core'));
    for (const f of features) {
      const picked = narrow ? f.scenarios.filter(s => s.tags.includes(issueTag) || s.tags.includes('@core')) : f.scenarios;
      if (!narrow || picked.length) selected.push({ module: m.name, ...f, scenarios: picked,
        reason: narrow ? '已核對影響範圍，選取 ' + issueTag + ' 與 @core' : reason });
    }
  }
  let bddStatus = 'BLOCKED';
  if (staticPassed && !problems.length) {
    if (level === 'FAST') bddStatus = 'SKIPPED';
    else if (selected.length) bddStatus = 'PENDING';
  }
  return { head, base, paths, risk: v['review-risk'], reviewReason: v['review-reason'],
    staticPassed, level, reason, unmatched: impact.unmatched, lint: problems, selected, bddStatus };
}
