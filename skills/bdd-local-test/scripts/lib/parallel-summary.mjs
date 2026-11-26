import fs from 'node:fs';
import path from 'node:path';
import { EOL } from 'node:os';
import { parseArgs } from 'node:util';
import { commit, repoRoot } from './git-changes.mjs';
import { checkScenarioIds, declaredScenarioIds, parseFeature } from './module-index.mjs';
import { git, repoIdentity } from './verification-git.mjs';
import { readContract } from './parallel-contracts.mjs';
import {
  approvedRepoKey, approvedScenarioKey as scenarioKey, compareApprovedPlan,
  loadApprovedPlan, matchesApprovedTarget, matchesPlanReference, sameApprovedScenario,
} from './parallel-plan.mjs';
import { artifact, checkModifiedPaths, checkSeparateDirectories, evidenceChecker, pathKey, readJson } from './summary-evidence.mjs';

const statusFields = { passed: 'passed', failed: 'failed', blocked: 'blocked', 'not-run': 'notRun' };
const counts = () => ({ passed: 0, failed: 0, blocked: 0, 'not-run': 0 });
const key = (...parts) => JSON.stringify(parts.map(s => s.toLowerCase()));
const roundKey = (feature, id, role) => JSON.stringify([pathKey(feature), id.toLowerCase(), role]);
const label = s => s.feature + '|' + s.id;

function verificationRound(root, a, r, repo, approvedRevision) {
  if (!r.verification) throw new Error('Missing verification reference');
  const verification = readJson(artifact(root, r.verification.path));
  if (!Array.isArray(verification?.rounds)) throw new Error('Invalid verification roundIndex');
  const round = verification.rounds[r.verification.roundIndex];
  if (!round) throw new Error('Invalid verification roundIndex');
  if (!round.repo || typeof round.head !== 'string' || !round.head) throw new Error('Incomplete verification version');
  if (!Array.isArray(round.dirtyPaths) || !Array.isArray(round.scenarios) ||
      !round.result || typeof round.result !== 'object' || Array.isArray(round.result)) {
    throw new Error('Incomplete verification round structure');
  }
  if (approvedRevision && (round.revision?.head !== approvedRevision.head ||
      round.revision?.dirtySha256 !== approvedRevision.dirtySha256)) {
    throw new Error('Recorded candidate revision is missing or differs from the approved plan. Record the tested checkout with --capture-revision.');
  }
  if (round.head !== a.target.head || !r.execution.serviceVersion || r.execution.serviceVersion !== a.target.serviceVersion) {
    throw new Error('Actual version differs from assignment or is unknown');
  }
  if (r.execution.uiUrl !== a.environment.uiUrl || r.execution.apiUrl !== a.environment.apiUrl) {
    throw new Error('Actual URLs differ from assignment');
  }
  if (a.target.dirtyPaths.length || round.dirtyPaths.length) {
    throw new Error('Dirty version needs manual snapshot review; cannot automatically accept');
  }
  if (!repo) throw new Error('Cannot verify assignment repo identity');
  let workDir;
  try { workDir = repoRoot(a.target.workDir); } catch { throw new Error('Assignment workDir differs from repo'); }
  if (approvedRepoKey(repo) !== approvedRepoKey(workDir)) throw new Error('Assignment workDir differs from repo');
  let head;
  try { head = commit(repo, round.head); } catch { throw new Error('Recorded HEAD is not an existing full commit SHA'); }
  if (head !== round.head) throw new Error('Recorded HEAD is not an existing full commit SHA');
  const identity = repoIdentity(repo);
  if (identity.name !== round.repo.name || identity.url !== round.repo.url) throw new Error('Verification repo differs from assignment');
  return round;
}

function checkScenarios(root, a, r, round, repo, historicalFeatures) {
  artifact(root, r.artifacts.report);
  if (r.artifacts.masking) artifact(root, r.artifacts.masking);
  checkModifiedPaths(r.modifiedPaths, a.permissions.editablePaths);
  const checkEvidence = evidenceChecker(root);
  const recorded = new Set();
  for (const s of round.scenarios) {
    if (typeof s?.path !== 'string' || typeof s.role !== 'string' || !Array.isArray(s.ids) || s.blob === null) continue;
    for (const id of s.ids) if (typeof id === 'string') recorded.add(roundKey(s.path, id, s.role));
  }
  const results = new Map();
  const total = counts();
  for (const s of r.scenarios) {
    if (results.has(scenarioKey(s))) throw new Error('Duplicate result scenario: ' + label(s));
    results.set(scenarioKey(s), s);
    if (!recorded.has(roundKey(s.feature, s.id, s.kind))) throw new Error('Scenario absent from verification round: ' + label(s));
    if (historicalFeatures) {
      const key = JSON.stringify([repo, round.head, s.feature]);
      if (!historicalFeatures.has(key)) {
        const source = git(repo, ['cat-file', 'blob', round.head + ':' + s.feature]);
        historicalFeatures.set(key, declaredScenarioIds(parseFeature(source, s.feature)));
      }
      checkScenarioIds(historicalFeatures.get(key), [s.id], s.feature);
    }
    for (const reference of s.evidence) checkEvidence(reference, s.status === 'passed');
    if (s.status === 'passed' && (!s.expected || !s.actual)) throw new Error('Passed scenario lacks expected/actual: ' + label(s));
    total[s.status]++;
  }
  for (const [status, field] of Object.entries(statusFields)) {
    if (round.result[field] !== total[status]) throw new Error('Verification count mismatch: ' + status);
  }
  const states = new Map();
  for (const { id } of r.resourceStates) states.set(id.toLowerCase(), (states.get(id.toLowerCase()) || 0) + 1);
  for (const { id } of a.resources) {
    if (states.get(id.toLowerCase()) !== 1) throw new Error('Missing or duplicate resource state: ' + id);
  }
  if (r.rerunScenarios.length) throw new Error('Pending rerun scenarios');
  return results;
}

function groupResults(root, a, group, issues, versions, { repo, repoId }, approvedRevision, historicalFeatures) {
  const resultPath = path.join(path.dirname(group.assignment), 'result.json');
  let result;
  try {
    result = readContract(artifact(root, path.relative(root, resultPath)), 'result');
    for (const field of ['runId', 'groupId', 'attempt']) {
      if (result[field] !== a[field]) throw new Error('Result identity mismatch: ' + field);
    }
    if (result.approvedPlanSha256 !== a.approvedPlan?.sha256) throw new Error('Result approved plan digest differs from assignment');
    group.result = resultPath;
  } catch (err) {
    issues.push(a.groupId + ': ' + err.message);
    return new Map();
  }
  if (result.taskStatus !== 'completed' || result.blockers.length) issues.push(a.groupId + ': Task incomplete or unresolved blockers');
  try {
    const round = verificationRound(root, a, result, repo, approvedRevision);
    group.version = { repo: round.repo, head: round.head, serviceVersion: result.execution.serviceVersion };
    versions.add(JSON.stringify([repoId, round.head, result.execution.serviceVersion]));
    return checkScenarios(root, a, result, round, repo, approvedRevision && historicalFeatures);
  } catch (err) {
    issues.push(a.groupId + ': ' + err.message);
    return new Map(result.scenarios.filter(s => s.status === 'blocked' && s.reason).map(s => [scenarioKey(s), s]));
  }
}

export function summarize(assignments, destination, planFile) {
  const records = assignments.map(file => readContract(file, 'assignment'));
  const selectedPlan = planFile ?? records.find(a => a.approvedPlan)?.approvedPlan.path;
  const plan = selectedPlan ? loadApprovedPlan(selectedPlan) : null;
  const issues = plan ? compareApprovedPlan(plan, records) : [];
  const groups = [];
  const scenarios = [];
  const approvedGroups = new Map();
  for (const group of plan?.groups ?? []) {
    const rows = new Map();
    for (const s of group.scenarios) {
      const row = { groupId: group.groupId, repo: group.repo, ...s, status: 'not-run' };
      scenarios.push(row);
      rows.set(scenarioKey(s), row);
    }
    approvedGroups.set(group.groupId, { repo: approvedRepoKey(group.repo), revision: group.revision, rows, submissions: 0 });
  }
  for (const a of records) {
    const group = approvedGroups.get(a.groupId);
    if (group) group.submissions++;
  }
  const seen = new Set();
  const versions = new Set();
  const identities = new Set();
  const repos = new Map();
  const historicalFeatures = new Map();
  const total = counts();
  let runId = plan?.runId;
  for (const [index, file] of assignments.entries()) {
    const a = records[index];
    const root = path.resolve(a.outputDir);
    checkSeparateDirectories(root, destination);
    runId ??= a.runId;
    if (a.runId !== runId) issues.push('Mixed runId: ' + a.groupId);
    const identity = key(a.runId, a.groupId);
    if (identities.has(identity)) issues.push('Duplicate group assignment: ' + a.runId + '|' + a.groupId);
    identities.add(identity);
    const group = { groupId: a.groupId, attempt: a.attempt, assignment: path.resolve(file), result: null, version: null };
    groups.push(group);
    const target = path.resolve(a.target.repo);
    if (!repos.has(target)) {
      let identity = { repo: null, repoId: target };
      try {
        const repo = repoRoot(target);
        const metadata = git(repo, ['rev-parse', '--git-common-dir']).trimEnd();
        identity = { repo, repoId: approvedRepoKey(path.resolve(repo, metadata)) };
      } catch { /* Keep known blockers even when the checkout is missing. */ }
      repos.set(target, identity);
    }
    const checkout = repos.get(target);
    const approved = approvedGroups.get(a.groupId);
    const results = groupResults(root, a, group, issues, versions, checkout, approved?.revision, historicalFeatures);
    const assigned = new Set();
    const bound = approved?.submissions === 1 && a.runId === runId && matchesPlanReference(plan, a) &&
      approved.repo === approvedRepoKey(a.target.repo) && matchesApprovedTarget(approved.revision, a.target);
    for (const s of a.scenarios) {
      const id = scenarioKey(s);
      if (assigned.has(id)) issues.push('Duplicate assigned scenario: ' + label(s));
      assigned.add(id);
      const globalId = JSON.stringify([checkout.repoId, id]);
      if (seen.has(globalId)) {
        issues.push('Repeated cross-group scenario requires manual review: ' + label(s));
        // A stray submission cannot reserve a scenario owned by an approved group.
        if (!plan) continue;
      }
      seen.add(globalId);
      let status = 'not-run';
      const actual = results.get(id);
      if (!actual) issues.push('Missing or unacceptable scenario result: ' + a.groupId + '/' + label(s));
      else if (plan?.scope === 'batch' && (actual.feature !== s.feature || actual.id !== s.id)) {
        issues.push('Result path or ID differs from the batch assignment: ' + label(actual));
      }
      else if (actual.kind !== s.kind) issues.push('Scenario kind mismatch: ' + label(s));
      else status = actual.status;
      if (!plan) {
        scenarios.push({ groupId: a.groupId, repo: a.target.repo, ...s, status });
      } else if (bound) {
        const row = approved.rows.get(id);
        if (row && sameApprovedScenario(row, s, plan.scope === 'batch')) row.status = status;
      }
    }
    for (const [id, s] of results) if (!assigned.has(id)) issues.push('Unexpected result scenario: ' + label(s));
  }
  if (versions.size > 1) issues.push('Multiple tested versions: keep separate; no combined pass eligibility.');
  for (const s of scenarios) total[s.status]++;
  return {
    contractVersion: 1, runId, eligibleForReview: scenarios.length > 0 && !issues.length && total.passed === scenarios.length,
    ...(plan && { approvedPlan: plan.reference }), counts: total, issues, groups, scenarios,
    limitation: 'Structural acceptance only: main agent must review evidence content, environment, dependencies and final integration. Resource release is not inferred.' +
      (plan?.contractVersion === 1 ? ' The historical v1 plan did not record the reviewed candidate revision.' : '') +
      (plan?.contractVersion === 2 ? ' The historical v2 plan did not bind a batch selection.' : ''),
  };
}

function writeSummary(dir, summary) {
  const { counts: c } = summary;
  const lines = [
    '# Parallel BDD summary', '', 'Run: ' + summary.runId, 'Eligible for evidence review: ' + (summary.eligibleForReview ? 'True' : 'False'),
    'Passed: ' + c.passed + '; failed: ' + c.failed + '; blocked: ' + c.blocked + '; not-run: ' + c['not-run'], '',
    summary.limitation, '', '## Adoption issues', '',
    ...summary.issues.map(issue => '- ' + issue),
  ];
  const json = JSON.stringify(summary, null, 2);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir); // Only the winner of a concurrent invocation can write these files.
  const created = [];
  try {
    for (const [name, data] of [['SUMMARY.md', lines.join(EOL)], ['summary.json', json]]) {
      const file = path.join(dir, name);
      const fd = fs.openSync(file, 'wx');
      created.push(file);
      try { fs.writeFileSync(fd, data + EOL); } finally { fs.closeSync(fd); }
    }
  } catch (err) {
    for (const file of created) fs.unlinkSync(file);
    fs.rmdirSync(dir);
    throw err;
  }
  return json;
}

export function parallelSummary(args) {
  try {
    const { values } = parseArgs({ args, options: {
      assignment: { type: 'string', multiple: true, default: [] }, plan: { type: 'string' }, 'output-dir': { type: 'string' },
    } });
    if ((!values.assignment.length && !values.plan) || values.assignment.some(file => !file) || values.plan === '' || !values['output-dir']) {
      throw new Error('Expected --assignment or --plan, and --output-dir.');
    }
    const dir = path.resolve(values['output-dir']);
    if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw new Error('OutputDir must be a new directory; existing summaries are never overwritten.');
    const summary = summarize(values.assignment, dir, values.plan);
    console.log(writeSummary(dir, summary));
    return summary.issues.length ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    return 2;
  }
}
