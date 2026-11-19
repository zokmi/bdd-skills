'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { loadKitConfig } = require('../scripts/lib/kit-config.cjs');
const schema = require('../schemas/config.schema.json');

function fixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.bdd'));
  fs.writeFileSync(path.join(root, '.bdd/config.json'), '\uFEFF' + JSON.stringify(config));
  return root;
}

test('loads schema examples and preserves unrelated legacy config', t => {
  for (const config of [...schema.examples, {}, { archive: { custom: true } }, { kit: {} }]) {
    assert.deepEqual(loadKitConfig(fixture(t, config)), config.kit ?? {});
  }
});

const invalid = [
  [null, ''], [[], ''], [{ kit: null }, '/kit'],
  [{ kit: { apii: {} } }, '/kit/apii'],
  [{ kit: { api: { timeoutMs: '30' } } }, '/kit/api/timeoutMs'],
  [{ kit: { api: { timeoutMs: 0 } } }, '/kit/api/timeoutMs'],
  [{ kit: { routing: {} } }, '/kit/routing'],
  [{ kit: { routing: { apiPorts: [81, 81] } } }, '/kit/routing/apiPorts'],
  [{ kit: { routing: { apiPorts: [65536] } } }, '/kit/routing/apiPorts/0'],
  [{ kit: { api: { ports: { app: { port: 81, protocol: 'ftp' } } } } }, '/kit/api/ports/app'],
  [{ kit: { api: { login: { main: { endpoint: 'app:/login' } } } } }, '/kit/api/login/main'],
  [{ kit: { database: { enabled: true } } }, '/kit/database'],
  [{ kit: { database: { enabled: true, connectionEnv: 'BAD-NAME' } } }, '/kit/database/connectionEnv'],
];
for (const [config, pointer] of invalid) {
  test('rejects invalid config ' + JSON.stringify(config), t => {
    const root = fixture(t, config);
    assert.throws(() => loadKitConfig(root), error => {
      assert.match(error.message, /Invalid BDD config/);
      assert.ok(error.message.includes(path.join(root, '.bdd/config.json')));
      assert.ok(error.message.includes(pointer || '/'));
      return true;
    });
  });
}

test('invalid config stops CLI before emitting executable snippet and does not leak values', t => {
  const secret = 'fixture-secret-do-not-print';
  const root = fixture(t, { kit: { api: { password: secret } } });
  const cli = path.resolve(__dirname, '../scripts/route-snippet.cjs');
  const result = spawnSync(process.execPath, [cli, '127.0.0.2'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Invalid BDD config/);
  assert.ok(!result.stderr.includes(secret));
});

test('disabled database does not require connection settings', t => {
  assert.deepEqual(loadKitConfig(fixture(t, { kit: { database: { enabled: false } } })),
    { database: { enabled: false } });
});
