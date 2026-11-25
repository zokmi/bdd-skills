import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { readContract } from './parallel-contracts.mjs';
import { approvedPlan, assignment } from './parallel-validators.mjs';
import { pathKey } from './summary-evidence.mjs';
import { git } from './verification-git.mjs';

export const approvedScenarioKey = s => JSON.stringify([pathKey(s.feature), s.id.toLowerCase()]);
const label = s => s.feature + '|' + s.id;

export function sameApprovedScenario(planned, actual) {
  return approvedScenarioKey(planned) === approvedScenarioKey(actual) &&
    planned.kind === actual.kind && isDeepStrictEqual(planned.assertions, actual.assertions);
}

// An assignment targets one checkout. Only duplicate scenario ownership spans linked worktrees.
export function approvedRepoKey(repo) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) return null;
  return pathKey(fs.existsSync(repo) ? fs.realpathSync.native(repo) : path.resolve(repo));
}

export function matchesPlanReference(plan, actual) {
  return actual.approvedPlan?.sha256 === plan.reference.sha256 &&
    approvedRepoKey(actual.approvedPlan.path) === approvedRepoKey(plan.reference.path);
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

function validateScope(groups) {
  const groupIds = new Set();
  const owners = new Map();
  const commonDirs = new Map();
  function commonDir(repo) {
    if (!commonDirs.has(repo)) {
      const metadata = git(repo, ['rev-parse', '--git-common-dir'], [0, 128]);
      commonDirs.set(repo, metadata ? approvedRepoKey(path.resolve(repo, metadata.trimEnd())) : repo);
    }
    return commonDirs.get(repo);
  }
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
  validateScope(plan.groups);
  return { ...plan, reference: { path: path.resolve(file), sha256: createHash('sha256').update(bytes).digest('hex') } };
}

function compareGroup(plan, group, actual, issues) {
  if (actual.runId !== plan.runId) issues.push('Approved runId mismatch: ' + group.groupId);
  if (approvedRepoKey(actual.target.repo) !== approvedRepoKey(group.repo)) {
    issues.push('Approved repo mismatch: ' + group.groupId);
  }
  if (!matchesPlanReference(plan, actual)) issues.push('Approved plan reference mismatch: ' + group.groupId);

  const remaining = new Map(group.scenarios.map(s => [approvedScenarioKey(s), s]));
  for (const scenario of actual.scenarios) {
    const key = approvedScenarioKey(scenario);
    const planned = remaining.get(key);
    if (!planned) issues.push('Unexpected or duplicate assigned scenario: ' + group.groupId + '/' + label(scenario));
    else if (!sameApprovedScenario(planned, scenario)) {
      issues.push('Approved scenario kind or assertions differ: ' + group.groupId + '/' + label(scenario));
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
  const issues = [];
  compareGroup(plan, group, result, issues);
  if (issues.length) throw new Error(issues.join('\n'));
  return result;
}

function writeNewAssignment(file, content) {
  const staged = path.join(path.dirname(file), '.bdd-assignment-' + randomUUID());
  const fd = fs.openSync(staged, 'wx');
  try {
    try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
    // Publish the completed file without replacing an earlier dispatch, even under a race.
    fs.linkSync(staged, file);
  } finally { fs.unlinkSync(staged); }
}

function markdownCell(value) {
  return value.replace(/[&<>|\\`*_\[\]~!]/g, c => '&#' + c.codePointAt(0) + ';').replace(/\r\n?|\n/g, '<br>');
}

function report(plan) {
  const rows = [
    '核准清單 SHA-256 `' + plan.reference.sha256 + '`', '',
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
      plan: { type: 'string' }, template: { type: 'string' }, report: { type: 'boolean' },
      assignment: { type: 'string', multiple: true }, output: { type: 'string' },
    } });
    if (!values.plan || [values.template, values.report, values.assignment].filter(Boolean).length !== 1) {
      throw new Error('Expected --plan and one of --template, --report, or --assignment.');
    }
    if (values.output !== undefined && (!values.output || !values.template)) throw new Error('--output requires --template and a new file path');
    const plan = loadApprovedPlan(values.plan);
    if (values.template) {
      const json = JSON.stringify(generateAssignment(plan, values.template), null, 2);
      if (values.output) writeNewAssignment(values.output, json + '\n');
      else console.log(json);
    } else if (values.report) console.log(report(plan));
    else {
      const issues = compareApprovedPlan(plan, values.assignment.map(file => readContract(file, 'assignment')));
      console.log(JSON.stringify({ runId: plan.runId, approvedPlan: plan.reference, issues }));
      if (issues.length) return 1;
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}
