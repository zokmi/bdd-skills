import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readContract } from '../scripts/lib/parallel-contracts.mjs';

const guide = readFileSync(new URL('../references/parallel-bdd-contract.md', import.meta.url), 'utf8');
const examples = [...guide.matchAll(/^```json\r?\n([\s\S]*?)\r?\n```/gm)].map(match => JSON.parse(match[1]));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bdd-contracts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'contract.json');
}

test('reads documented UTF-8 assignment and result with or without a BOM', t => {
  const file = fixture(t);
  for (const [kind, example] of [['assignment', examples[0]], ['result', examples[1]]]) {
    for (const bom of ['', '\uFEFF']) {
      writeFileSync(file, bom + JSON.stringify(example));
      assert.deepEqual(readContract(file, kind), example);
    }
  }
});

test('rejects invalid nested types, extra fields, and conditional result violations', t => {
  const file = fixture(t);
  function reject(kind, edit) {
    const record = structuredClone(examples[kind === 'assignment' ? 0 : 1]);
    edit(record);
    writeFileSync(file, JSON.stringify(record));
    assert.throws(() => readContract(file, kind), new RegExp('Invalid ' + kind + ' schema'));
  }
  reject('assignment', a => { a.attempt = '1'; });
  reject('assignment', a => { a.environment.unreviewed = true; });
  reject('result', r => { r.verification = null; r.blockers = []; });
  reject('result', r => { r.scenarios[0].status = 'passed'; r.scenarios[0].evidence = []; });
  reject('result', r => { r.scenarios[0].status = 'blocked'; r.scenarios[0].reason = null; });
  reject('result', r => { r.scenarios[0].status = 'failed'; r.scenarios[0].actual = null; });
});

test('parse errors identify the file without echoing malformed document contents', t => {
  const file = fixture(t);
  writeFileSync(file, '{"privateField":"privateExampleValue"');
  assert.throws(() => readContract(file, 'result'), { message: 'Invalid JSON in ' + file });
  assert.throws(() => readContract(file, 'constructor'), TypeError);
});
