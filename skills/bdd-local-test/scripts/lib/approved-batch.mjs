import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateEngineeringChecks } from './engineering-checks.mjs';

const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256 = /^[0-9a-f]{64}$/;
const scenarioKey = (feature, id) => JSON.stringify([feature, id]);
const display = key => JSON.parse(key).join('::');

function readSelection(reference, runId) {
  if (!path.isAbsolute(reference.path)) throw new Error('Expected an absolute batch selection path: ' + reference.path);
  const bytes = fs.readFileSync(reference.path);
  if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
    throw new Error('Batch selection SHA-256 mismatch: ' + reference.path);
  }
  const selection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (selection?.issueScope !== 'batch' || selection.runId !== runId ||
      typeof selection.issue !== 'string' || !/^\d+$/.test(selection.issue)) {
    throw new Error('Expected a batch selection for this runId and issue: ' + reference.path);
  }
  const engineering = selection.engineeringChecks === undefined ? [] : validateEngineeringChecks(selection.engineeringChecks, selection.paths);
  if (selection.bddStatus !== 'PENDING' || !['TARGETED', 'FULL'].includes(selection.level) || selection.staticPassed !== true ||
      selection.blockers?.length || selection.lint?.length ||
      !Array.isArray(selection.selected) || !(selection.selected.length || engineering.length)) {
    throw new Error('Batch selection is not ready for dispatch: ' + reference.path);
  }
  const { repo, base, head, revision } = selection;
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || !commitId.test(base) || !commitId.test(head) ||
      revision?.head !== head || (revision.dirtySha256 !== null && !sha256.test(revision.dirtySha256))) {
    throw new Error('Invalid batch selection repo, base or candidate revision: ' + reference.path);
  }
  const expected = new Set();
  for (const { feature, scenarios } of selection.selected) {
    if (typeof feature !== 'string' || !feature || !Array.isArray(scenarios) || !scenarios.length) {
      throw new Error('Expected selected scenarios in batch selection: ' + reference.path);
    }
    for (const { ids } of scenarios) {
      if (!Array.isArray(ids) || !ids.length) throw new Error('Missing batch scenario ID in ' + feature);
      for (const id of ids) {
        if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid batch scenario ID in ' + feature);
        const key = scenarioKey(feature, id);
        if (expected.has(key)) throw new Error('Duplicate batch scenario: ' + display(key));
        expected.add(key);
      }
    }
  }
  return { repo, base, revision, issue: selection.issue, expected, engineering };
}

// Match the union of every group's scenarios to the immutable output of quality-plan.
// Linked worktrees at the same candidate can share a selection, unrelated repositories cannot.
export function validateBatchScope(plan, commonDir) {
  const candidate = (repo, revision) => JSON.stringify([commonDir(repo), revision.head, revision.dirtySha256]);
  const approved = new Map();
  for (const group of plan.groups) {
    const key = candidate(group.repo, group.revision);
    if (!approved.has(key)) approved.set(key, { ids: new Set(), checks: new Map() });
    const { ids, checks } = approved.get(key);
    for (const s of group.scenarios) ids.add(scenarioKey(s.feature, s.id));
    for (const check of group.engineeringChecks ?? []) checks.set(check.id, check);
  }
  let issue;
  const evidence = [];
  for (const reference of plan.selections) {
    const selection = readSelection(reference, plan.runId);
    issue ??= selection.issue;
    if (selection.issue !== issue) throw new Error('Batch selections refer to different issues');
    const key = candidate(selection.repo, selection.revision);
    const batch = approved.get(key);
    if (!batch) throw new Error('Unexpected or duplicate batch selection for this checkout and revision: ' + selection.repo);
    const { ids, checks } = batch;
    if (checks.size !== selection.engineering.length || selection.engineering.some(c => !isDeepStrictEqual(c, checks.get(c.id)))) {
      throw new Error('Approved engineering checks differ from the batch selection for ' + selection.repo);
    }
    const missing = [...selection.expected].filter(s => !ids.has(s));
    const extra = [...ids].filter(s => !selection.expected.has(s));
    if (missing.length || extra.length) {
      const differences = [
        ...missing.map(s => 'Missing selected scenario: ' + display(s)),
        ...extra.map(s => 'Unexpected approved scenario: ' + display(s)),
      ];
      throw new Error('Approved plan differs from batch selection for ' + selection.repo + '\n' + differences.join('\n'));
    }
    approved.delete(key);
    evidence.push({ ...reference, issue, base: selection.base, repo: selection.repo });
  }
  if (approved.size) throw new Error('Missing batch selection for an approved checkout and candidate revision');
  return evidence;
}
