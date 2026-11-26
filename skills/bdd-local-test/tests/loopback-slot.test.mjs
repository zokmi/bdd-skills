import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { listProcesses, withAllocationLocks } from '../scripts/lib/windows-host.mjs';
import { worktreeFixture } from './worktree-fixture.mjs';

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
    // FileShare.None rejects a second writable handle to either legacy lock, even in a Node process.
    for (const lock of [path.join(registry, 'allocation.lock'), path.join(repo, '.git', 'bdd-loopback-allocation.lock')]) {
      assert.throws(() => fs.closeSync(fs.openSync(lock, 'r+')), { code: 'EBUSY' });
    }
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

test('concurrent worktrees in two repositories reserve and reuse distinct slots before listening', {
  skip: process.platform !== 'win32',
}, async t => {
  const fixture = worktreeFixture();
  t.after(fixture.clean);
  const repos = ['project-a', 'project-b'].map(fixture.init);
  const allocate = target => fixture.bdd(target, 'loopback-slot', '--ports', '4200,9453');
  async function allocateTogether(targets) {
    const results = await Promise.allSettled(targets.map(allocate));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return results.map(result => result.value);
  }
  const targets = repos.flatMap((repo, i) => ['one', 'two'].map(name => fixture.worktree(repo, i + '-' + name)));
  const first = await allocateTogether(targets);
  assert.equal(new Set(first.map(r => r.ip)).size, 4);
  const reused = await allocateTogether(targets);
  assert.deepEqual(reused.map(r => [r.root, r.ip]), first.map(r => [r.root, r.ip]));
  const fresh = repos.flatMap((repo, i) => ['three', 'four'].map(name => fixture.worktree(repo, i + '-' + name)));
  const next = await allocateTogether(fresh);
  assert.equal(new Set(first.concat(next).map(r => r.ip)).size, 8);

  const marker = path.join(repos[1], '.git', 'bdd-loopback-slot');
  fs.writeFileSync(marker, String(first[0].slot));
  await assert.rejects(fixture.bdd(repos[1], 'loopback-slot', '--isolate'), /已由其他工作區預約/);
});

test('worktree preparation validates files, isolates sessions and uses a bindable port on collision', {
  skip: process.platform !== 'win32',
}, async t => {
  const fixture = worktreeFixture();
  t.after(fixture.clean);
  const repo = fixture.init('project');
  const a = fixture.worktree(repo, 'a');
  const b = fixture.worktree(repo, 'b');
  const state = path.join(fixture.root, 'private state.json');
  const installed = path.join(fixture.root, 'installed cli.js');
  fs.writeFileSync(state, '{"cookies":[],"origins":[]}');
  fs.writeFileSync(installed, '// fixture');
  const output = path.join(fixture.root, 'output');
  const invalid = path.join(fixture.root, 'invalid');
  for (const args of [['--storage-state', path.join(fixture.root, 'missing.json')],
    ['--cli-path', path.join(fixture.root, 'missing.js')], ['--ports', '0']]) {
    await assert.rejects(fixture.bdd(a, 'prepare-worktree-cli', '--ports', '4200', '--output-dir', invalid, ...args));
    assert.equal(fs.existsSync(invalid), false);
  }
  const prepare = (checkout, ports, ...rest) =>
    fixture.bdd(checkout, 'prepare-worktree-cli', '--ports', ports, '--output-dir', output, ...rest);
  const manifest = path.join(output, 'prepared.json');
  const configured = await prepare(a, '4200,5000', '--storage-state', state, '--cli-path', installed, '--manifest', manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), configured);
  const before = fs.readdirSync(output);
  await assert.rejects(prepare(a, '4200', '--manifest', manifest), /already exists/);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), configured);
  await assert.rejects(prepare(a, '4200', '--manifest', path.join(output, 'absent', 'prepared.json')));
  assert.deepEqual(fs.readdirSync(output), before);
  assert.equal(configured.storageState, state);
  assert.equal(configured.cliPath, installed);
  assert.deepEqual(configured.ports, [4200, 5000]);
  const config = JSON.parse(fs.readFileSync(configured.configPath, 'utf8'));
  assert.equal(config.browser.isolated, true);
  assert.deepEqual(config.browser.launchOptions.args, [configured.preflight.chromiumArg]);
  assert.match(configured.isolationId, /^bdd-cli-[a-f0-9]{32}$/);
  const fresh = await prepare(a, '4200,5000');
  assert.equal(fresh.storageState, undefined);
  assert.notEqual(fresh.isolationId, configured.isolationId);
  assert.equal(fresh.preflight.slot, configured.preflight.slot);

  async function listen(host, port) {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen({ host, port, exclusive: true }, resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return server;
  }
  const owner = await listen('0.0.0.0', 0);
  const port = owner.address().port;
  const fallback = await prepare(a, String(port));
  const [mapping] = fallback.portMappings;
  assert.equal(mapping.originalPort, port);
  assert.notEqual(mapping.effectivePort, port);
  assert.deepEqual(fallback.effectivePorts, [mapping.effectivePort]);
  assert.ok(mapping.effectivePort > 0);
  await listen(fallback.preflight.ip, mapping.effectivePort);
  const fixed = await fixture.bdd(a, 'loopback-slot', '--ports', String(port), '--keep-original-ports');
  assert.equal(fixed.portMappings[0].effectivePort, port);
  assert.equal(owner.address().port, port);

  const main = await prepare(repo, '4200');
  assert.deepEqual(JSON.parse(fs.readFileSync(main.configPath, 'utf8')).browser.launchOptions.args, []);
  const marker = checkout => path.join(fixture.git('-C', checkout, 'rev-parse', '--absolute-git-dir'), 'bdd-loopback-slot');
  fs.writeFileSync(marker(b), String(configured.preflight.slot));
  await assert.rejects(fixture.bdd(a, 'loopback-slot'), /重複/);
  fs.writeFileSync(marker(b), '254');
  fs.writeFileSync(marker(a), '1');
  await assert.rejects(fixture.bdd(a, 'loopback-slot'), /無效/);
});
