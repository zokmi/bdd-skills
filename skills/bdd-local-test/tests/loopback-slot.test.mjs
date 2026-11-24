import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { listProcesses, withAllocationLocks } from '../scripts/lib/windows-host.mjs';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const run = promisify(execFile);

function fixture(t) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-slot-migration-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const registry = path.join(tmp, 'registry');
  const repo = path.join(tmp, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' }).trim();
  git('init', '-q', repo);
  const env = { ...process.env, BDD_LOOPBACK_REGISTRY_DIR: registry };
  const allocate = async (...args) => {
    const { stdout } = await run(process.execPath, [cli, 'loopback-slot', ...args], { cwd: repo, env });
    return JSON.parse(stdout);
  };
  return { tmp, repo, registry, git, allocate };
}

test('ordinary checkout keeps default localhost and port validation happens before allocation', async t => {
  const { repo, registry, allocate } = fixture(t);
  const slot = await allocate();
  assert.equal(slot.slot, 1);
  assert.equal(slot.isolated, false);
  assert.equal(slot.isWorktree, false);
  assert.equal(slot.registryPath, null);
  assert.deepEqual(slot.portMappings, []);
  assert.equal(path.relative(fs.realpathSync.native(slot.root), fs.realpathSync.native(repo)), '');
  await assert.rejects(allocate('--isolate', '--ports', '65536'));
  assert.equal(fs.existsSync(registry), false);
});

test('a writer that lost its native lock cannot publish a stale reservation', { skip: process.platform !== 'win32' }, async t => {
  const { repo, registry } = fixture(t);
  const gitDir = path.join(repo, '.git');
  const ledger = path.join(registry, 'reservations.json');
  const marker = path.join(gitDir, 'bdd-loopback-slot');
  let interrupted = false;
  const replacement = JSON.stringify({ version: 1, leases: [{ gitDir, slot: 3 }] });
  await assert.rejects(withAllocationLocks(registry, gitDir, async publish => {
    // Only interrupt this test's own child holding the unique temporary registry.
    const holder = (await listProcesses()).filter(p => p.parentPid === process.pid &&
      p.name === 'windows-host.exe' && p.commandLine?.includes(registry) && p.commandLine.includes(gitDir));
    assert.equal(holder.length, 1);
    process.kill(holder[0].pid);
    await withAllocationLocks(registry, gitDir, commit => commit({ gitDir, registryJson: replacement, slot: 3 }));
    interrupted = true;
    await publish({ gitDir, registryJson: '{}', slot: 2 });
  }));
  assert.equal(interrupted, true);
  assert.equal(fs.readFileSync(ledger, 'utf8'), replacement);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '3');
});

test('both legacy FileShare.None locks exclude old writers and allocation preserves v1 reservations', {
  skip: process.platform !== 'win32',
}, async t => {
  const { tmp, repo, registry, allocate } = fixture(t);
  const legacy = path.join(tmp, 'another-repo.git');
  fs.mkdirSync(legacy);
  const marker = path.join(legacy, 'bdd-loopback-slot');
  fs.writeFileSync(marker, '2');
  fs.mkdirSync(registry);
  const file = path.join(registry, 'reservations.json');
  const original = '\uFEFF' + JSON.stringify({ version: 1, leases: [{ slot: 2, gitDir: legacy }] });
  fs.writeFileSync(file, original);
  await withAllocationLocks(registry, path.join(repo, '.git'), async () => {
    const script = [
      "$ErrorActionPreference='Stop'",
      'foreach ($file in $env:BDD_TEST_GLOBAL,$env:BDD_TEST_COMMON) {',
      "  try { $h=[IO.File]::Open($file, 'OpenOrCreate', 'ReadWrite', 'None') }",
      '  catch [IO.IOException] { if (($_.Exception.GetBaseException().HResult -band 65535) -in 32,33) { continue }; throw }',
      '  $h.Dispose(); throw "legacy writer acquired locked file"',
      '}',
      'exit 0',
    ].join('\n');
    await run('pwsh', ['-NoProfile', '-Command', script], { env: { ...process.env,
      BDD_TEST_GLOBAL: path.join(registry, 'allocation.lock'), BDD_TEST_COMMON: path.join(repo, '.git', 'bdd-loopback-allocation.lock'),
    } });
  });
  const selected = await allocate('--isolate');
  assert.ok(selected.slot > 2);
  const stable = fs.readFileSync(file, 'utf8');
  assert.equal((await allocate('--isolate')).slot, selected.slot);
  assert.equal(fs.readFileSync(file, 'utf8'), stable);
  fs.writeFileSync(path.join(repo, '.git', 'bdd-loopback-slot'), '2');
  await assert.rejects(allocate('--isolate'));
  assert.equal(fs.readFileSync(file, 'utf8'), stable);
  assert.equal(fs.readFileSync(marker, 'utf8'), '2');
});
