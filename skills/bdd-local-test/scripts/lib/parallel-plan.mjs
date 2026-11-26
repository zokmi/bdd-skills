import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { readContract } from './parallel-contracts.mjs';
import { approvedPlan, assignment } from './parallel-validators.mjs';
import { captureApprovedRevision } from './approved-revision.mjs';
import { validateBatchScope } from './approved-batch.mjs';
import { repoRoot } from './git-changes.mjs';
import { checkScenarioIds, declaredScenarioIds, readFeature } from './module-index.mjs';
import { pathKey } from './summary-evidence.mjs';
import { git } from './verification-git.mjs';
import { writeNewFile } from './write-new-file.mjs';

export const approvedScenarioKey = s => JSON.stringify([pathKey(s.feature), s.id.toLowerCase()]);
const label = s => s.feature + '|' + s.id;

export function sameApprovedScenario(planned, actual, exact = false) {
  return approvedScenarioKey(planned) === approvedScenarioKey(actual) &&
    (!exact || (planned.feature === actual.feature && planned.id === actual.id)) &&
    planned.kind === actual.kind && isDeepStrictEqual(planned.assertions, actual.assertions);
}

// An assignment targets one checkout. Only duplicate scenario ownership spans linked worktrees.
export function approvedRepoKey(repo) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) return null;
  // Native realpath resolves aliases while preserving distinct names in case-sensitive directories.
  return fs.existsSync(repo) ? fs.realpathSync.native(repo) : path.resolve(repo);
}

export function matchesPlanReference(plan, actual) {
  return actual.approvedPlan?.sha256 === plan.reference.sha256 &&
    approvedRepoKey(actual.approvedPlan.path) === approvedRepoKey(plan.reference.path);
}

export function matchesApprovedTarget(revision, target) {
  // Historical v1 plans only bound the scenario list and its assertions.
  return !revision || (target.head === revision.head && Array.isArray(target.dirtyPaths) &&
    Boolean(target.dirtyPaths.length) === (revision.dirtySha256 !== null));
}

function parseJson(bytes, file) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid JSON in ' + file); }
}

function validate(validateSchema, value, description) {
  if (!validateSchema(value)) {
    const error = validateSchema.errors[0];
    throw new Error('Invalid ' + description + ': ' + (error.instancePath || '/') + ' ' + error.message);
  }
}

function checkoutFamilies() {
  const commonDirs = new Map();
  return repo => {
    if (!commonDirs.has(repo)) {
      const metadata = git(repo, ['rev-parse', '--git-common-dir'], [0, 128]);
      commonDirs.set(repo, metadata ? approvedRepoKey(path.resolve(repo, metadata.trimEnd())) : repo);
    }
    return commonDirs.get(repo);
  };
}

function validateScope(groups, commonDir) {
  const groupIds = new Set();
  const owners = new Map();
  for (const group of groups) {
    const groupKey = group.groupId.toLowerCase();
    if (groupIds.has(groupKey)) throw new Error('Duplicate approved group: ' + group.groupId);
    groupIds.add(groupKey);
    const repo = approvedRepoKey(group.repo);
    if (!repo) throw new Error('Expected absolute approved repo for group: ' + group.groupId);
    for (const scenario of group.scenarios) {
      if (path.win32.isAbsolute(scenario.feature) || /(^|[\\/])\.\.?([\\/]|$)|[\\:]/.test(scenario.feature) ||
          scenario.feature.includes('//')) {
        throw new Error('Expected a repo-relative feature path using forward slashes: ' + scenario.feature);
      }
      const key = approvedScenarioKey(scenario);
      const previous = owners.get(key) ?? [];
      // Most scenarios have a single owner, so planning those needs no Git calls.
      if (previous.some(owner => owner === repo || commonDir(owner) === commonDir(repo))) {
        throw new Error('Duplicate approved scenario: ' + group.groupId + '/' + label(scenario));
      }
      previous.push(repo);
      owners.set(key, previous);
    }
  }
}

export function loadApprovedPlan(file) {
  const bytes = fs.readFileSync(file);
  const plan = parseJson(bytes, file);
  validate(approvedPlan, plan, 'approved plan schema');
  const commonDir = checkoutFamilies();
  validateScope(plan.groups, commonDir);
  const batchEvidence = plan.scope === 'batch' ? validateBatchScope(plan, commonDir) : undefined;
  return { ...plan, batchEvidence, reference: { path: path.resolve(file), sha256: createHash('sha256').update(bytes).digest('hex') } };
}

function compareGroup(plan, group, actual, issues) {
  if (actual.runId !== plan.runId) issues.push('Approved runId mismatch: ' + group.groupId);
  if (approvedRepoKey(actual.target.repo) !== approvedRepoKey(group.repo)) {
    issues.push('Approved repo mismatch: ' + group.groupId);
  }
  if (!matchesPlanReference(plan, actual)) issues.push('Approved plan reference mismatch: ' + group.groupId);
  if (!matchesApprovedTarget(group.revision, actual.target)) {
    issues.push('Assignment HEAD or dirty state differs from the approved revision for group ' + group.groupId);
  }

  const remaining = new Map(group.scenarios.map(s => [approvedScenarioKey(s), s]));
  for (const scenario of actual.scenarios) {
    const key = approvedScenarioKey(scenario);
    const planned = remaining.get(key);
    if (!planned) issues.push('Unexpected or duplicate assigned scenario: ' + group.groupId + '/' + label(scenario));
    else if (!sameApprovedScenario(planned, scenario, plan.scope === 'batch')) {
      issues.push('Approved scenario path, ID, kind or assertions differ: ' + group.groupId + '/' + label(scenario));
    }
    remaining.delete(key);
  }
  for (const scenario of remaining.values()) issues.push('Missing approved scenario: ' + group.groupId + '/' + label(scenario));
}

export function compareApprovedPlan(plan, assignments) {
  const issues = [];
  const remaining = new Map(plan.groups.map(group => [group.groupId, group]));
  for (const actual of assignments) {
    const group = remaining.get(actual.groupId);
    if (group) compareGroup(plan, group, actual, issues);
    else issues.push('Unexpected or duplicate assignment group: ' + actual.groupId);
    remaining.delete(actual.groupId);
  }
  for (const groupId of remaining.keys()) issues.push('Missing approved group: ' + groupId);
  return issues;
}

// Review and dispatch concern the live checkout. Historical summaries compare the recorded versions.
function liveRevisionIssues(groups, assignments = []) {
  const issues = [];
  const snapshots = new Map();
  const featureIds = new Map();
  for (const group of groups) {
    const repo = approvedRepoKey(group.repo);
    try {
      if (!snapshots.has(repo)) snapshots.set(repo, captureApprovedRevision(group.repo));
      const current = snapshots.get(repo);
      if (current.head !== group.revision.head || current.dirtySha256 !== group.revision.dirtySha256) {
        issues.push('Candidate revision changed for group ' + group.groupId + ' (' + group.repo + '). Review the updated plan before dispatch.');
        continue;
      }
      for (const scenario of group.scenarios) {
        const file = path.join(repo, scenario.feature);
        if (!featureIds.has(file)) featureIds.set(file, declaredScenarioIds(readFeature(file, repo)));
        checkScenarioIds(featureIds.get(file), [scenario.id], scenario.feature);
      }
    } catch (error) {
      issues.push('Cannot confirm candidate revision for ' + group.groupId + ': ' + error.message);
    }
  }
  for (const { groupId, target } of assignments) {
    const repo = approvedRepoKey(target.repo);
    const workDir = approvedRepoKey(target.workDir);
    // A subdirectory is valid only when Git resolves it to the same checkout.
    if (workDir && workDir === repo) continue;
    try {
      if (workDir && approvedRepoKey(repoRoot(target.workDir)) === repo) continue;
    } catch { /* No checkout at the specified workDir. */ }
    issues.push('Assignment workDir differs from the approved checkout: ' + groupId);
  }
  return issues;
}

function generateAssignment(plan, file) {
  const template = parseJson(fs.readFileSync(file), file);
  if (!template || typeof template !== 'object' || Array.isArray(template)) throw new Error('Expected an assignment template object');
  if (Object.hasOwn(template, 'scenarios') || Object.hasOwn(template, 'approvedPlan')) {
    throw new Error('Omit scenarios and approvedPlan from the assignment template');
  }
  const group = plan.groups.find(group => group.groupId === template.groupId);
  if (!group) throw new Error('Group absent from approved plan: ' + template.groupId);
  const result = { ...template, scenarios: group.scenarios, approvedPlan: plan.reference };
  validate(assignment, result, 'assignment schema');
  const issues = liveRevisionIssues(plan.scope === 'batch' ? plan.groups : [group], [result]);
  compareGroup(plan, group, result, issues);
  if (issues.length) throw new Error(issues.join('\n'));
  return result;
}

function markdownCell(value) {
  return value.replace(/[&<>|\\`*_\[\]~!]/g, c => '&#' + c.codePointAt(0) + ';').replace(/\r\n?|\n/g, '<br>');
}

function report(plan) {
  const rows = [
    '核准清單 SHA-256 `' + plan.reference.sha256 + '`', '',
    '選測範圍：' + (plan.scope === 'batch' ? '回饋批次' : '非回饋批次'), '',
    ...(plan.batchEvidence ?? []).map(s => '- 本批 issue #' + s.issue + '，基準 `' + s.base +
      '`，選測結果 ' + markdownCell(s.path) + '，SHA-256 `' + s.sha256 + '`'),
    ...plan.groups.map(g => '- ' + markdownCell(g.groupId) + '（' + markdownCell(g.repo) + '） ' +
      '受審 commit `' + g.revision.head + '`，' +
      (g.revision.dirtySha256 === null ? '工作區乾淨' : '未提交內容 SHA-256 `' + g.revision.dirtySha256 + '`')),
    '',
    '| 組別 | 需求／驗收條件 | 情境編號與路徑 | 前置條件與實際觸發方式 | 預期結果 | 驗證手段與理由 | 預計證據 |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const group of plan.groups) {
    for (const s of group.scenarios) {
      for (const a of s.assertions) {
        const cells = [group.groupId, a.requirement, s.id + ' ' + s.feature, a.action, a.expected, a.method, a.evidence];
        rows.push('| ' + cells.map(markdownCell).join(' | ') + ' |');
      }
    }
  }
  return rows.join('\n');
}

export function parallelPlan(args) {
  try {
    const { values } = parseArgs({ args, options: {
      plan: { type: 'string' }, revision: { type: 'string' }, template: { type: 'string' }, report: { type: 'boolean' },
      assignment: { type: 'string', multiple: true }, output: { type: 'string' },
    } });
    if (values.revision !== undefined) {
      if (!values.revision || Object.keys(values).length !== 1) throw new Error('Use --revision <checkout root> on its own.');
      console.log(JSON.stringify(captureApprovedRevision(path.resolve(values.revision))));
      return 0;
    }
    if (!values.plan || [values.template, values.report, values.assignment].filter(Boolean).length !== 1) {
      throw new Error('Expected --plan and one of --template, --report, or --assignment.');
    }
    if (values.output !== undefined && (!values.output || !values.template)) throw new Error('--output requires --template and a new file path');
    const plan = loadApprovedPlan(values.plan);
    if (plan.contractVersion === 1) {
      throw new Error('Historical plan v1 lacks a reviewed candidate revision. Capture --revision and submit a v3 plan for review.');
    }
    if (plan.contractVersion === 2) {
      throw new Error('Historical plan v2 does not bind the batch selection. Submit a v3 plan with an explicit scope before dispatch.');
    }
    if (values.template) {
      const json = JSON.stringify(generateAssignment(plan, values.template), null, 2);
      if (values.output) writeNewFile(values.output, json + '\n');
      else console.log(json);
    } else if (values.report) {
      const issues = liveRevisionIssues(plan.groups);
      if (issues.length) throw new Error(issues.join('\n'));
      console.log(report(plan));
    } else {
      const records = values.assignment.map(file => readContract(file, 'assignment'));
      const issues = compareApprovedPlan(plan, records).concat(liveRevisionIssues(plan.groups, records));
      console.log(JSON.stringify({ runId: plan.runId, approvedPlan: plan.reference, issues }));
      if (issues.length) return 1;
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}
