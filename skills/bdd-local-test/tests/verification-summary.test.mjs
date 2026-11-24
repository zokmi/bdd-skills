import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const guide = new URL('../references/parallel-bdd-contract.md', import.meta.url);

test('summary adopts a recorded round and rejects the same result when its evidence disappears', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-summary-flow-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'product');
  const output = path.join(tmp, 'group');
  const attempt = path.join(output, 'coordination', 'attempt-1');
  fs.mkdirSync(repo);
  fs.mkdirSync(attempt, { recursive: true });
  const examples = fs.readFileSync(guide, 'utf8').matchAll(/^\x60{3}json\r?\n([\s\S]*?)\r?\n\x60{3}/gm);
  const [assignment, result] = Array.from(examples, match => JSON.parse(match[1]));
  const scenario = assignment.scenarios[0];
  const feature = path.join(repo, scenario.feature);
  fs.mkdirSync(path.dirname(feature), { recursive: true });
  fs.writeFileSync(feature, 'Feature: Checkout\n@' + scenario.id + ' @#1 @API\nScenario: Complete order\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'feature');
  function run(code, ...args) {
    const res = spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, code, res.stderr || res.stdout);
    return JSON.parse(res.stdout);
  }
  const head = git('rev-parse', 'HEAD');
  const round = run(0, 'verification', '--record', '--dir', output, '--commits', head,
    '--changed-scenarios', scenario.feature, '--passed', '1');
  assert.equal(round.head, head);
  assert.deepEqual(round.scenarios[0].ids, [scenario.id]);
  assert.equal(run(0, 'verification', '--check', '--dir', output).verdict, 'current');

  Object.assign(assignment.target, { repo, workDir: repo, head });
  assignment.outputDir = output;
  result.artifacts.masking = null;
  result.scenarios[0].evidence = ['observation.txt'];
  const record = path.join(attempt, 'assignment.json');
  fs.writeFileSync(record, JSON.stringify(assignment));
  fs.writeFileSync(path.join(attempt, 'result.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(output, 'REPORT.md'), 'Test report');
  const evidence = path.join(output, 'observation.txt');
  fs.writeFileSync(evidence, 'Order completed');
  function summarize(code, name) {
    const dir = path.join(tmp, name);
    const summary = run(code, 'parallel-summary', '--assignment', record, '--output-dir', dir);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')), summary);
    return summary;
  }
  const accepted = summarize(0, 'accepted');
  assert.equal(accepted.eligibleForReview, true);
  assert.equal(accepted.counts.passed, 1);
  fs.unlinkSync(evidence);
  const incomplete = summarize(1, 'incomplete');
  assert.equal(incomplete.eligibleForReview, false);
  assert.equal(incomplete.counts['not-run'], 1);
});
