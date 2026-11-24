import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stopSlotServices } from '../scripts/lib/stop-slot-services.mjs';

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-stop-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'test repo');
  const other = root + '-other';
  const profile = path.join(root, 'login profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(other);
  const file = path.join(root, 'app.js');
  fs.writeFileSync(file, 'fixture');
  const slot = path.join(dir, 'bdd-loopback-slot');
  fs.writeFileSync(slot, '5');
  const checkout = { root, gitDir: dir, isWorktree: true };
  const proc = (pid, parentPid, name, commandLine) => ({
    pid, parentPid, name, executablePath: '', commandLine, created: String(100000 + pid),
  });
  let processes = [
    proc(100, 0, 'node.exe', 'node "' + file + '"'),
    proc(101, 100, 'node.exe', 'node "' + file + '"'),
    proc(102, 0, 'chrome.exe', 'chrome "--user-data-dir=' + profile + '"'),
    proc(103, 102, 'chrome.exe', 'chrome --type=renderer --user-data-dir="' + profile + '"'),
    proc(104, 0, 'chrome.exe', 'chrome --user-data-dir="' + other + '" "' + file + '"'),
    proc(105, 0, 'node.exe', 'node "' + other + '"'),
    proc(106, 0, 'chrome.exe', 'chrome --user-data-dir="' + profile + '" --user-data-dir="' + other + '"'),
  ];
  const ip = '127.0.0.5';
  let listeners = [
    { address: ip, port: 4200, pid: 101 },
    { address: '0.0.0.0', port: 4200, pid: 105 },
    { address: '127.0.0.1', port: 4200, pid: 105 },
    { address: ip, port: 7890, pid: 104 },
  ];
  const calls = [];
  const host = {
    async listProcesses() { return processes; },
    async listListeners() { return listeners; },
    async terminateTree(pid, identity) {
      calls.push([pid, identity]);
      const removed = processes.filter(p => p.pid === pid || p.parentPid === pid);
      processes = processes.filter(p => !removed.includes(p));
      listeners = listeners.filter(l => !removed.some(p => p.pid === l.pid));
    },
  };
  function stop(options = {}) {
    return stopSlotServices(checkout, { dryRun: false, isolate: false, ports: [4200], ...options }, host);
  }
  return { stop, checkout, calls, host, slot, processes, listeners };
}

test('requires exact listener ownership and selects the worktree browser profile independently', async t => {
  const { stop, calls } = fixture(t);
  const preview = await stop({ dryRun: true, ports: [4200, 7890] });
  assert.deepEqual(preview.stopped.map(p => p.killedRootPid), [100]);
  assert.deepEqual(preview.browsers.map(p => p.pid), [102]);
  assert.deepEqual(preview.skipped.map(p => p.pid), [105, 104]);
  assert.deepEqual(calls, []);
  const report = await stop();
  assert.deepEqual(calls, [[102, '100102'], [100, '100100']]);
  assert.deepEqual(report.remaining, []);
  assert.deepEqual(report.remainingPids, []);
});

test('main checkout needs isolation and an invalid slot fails before process enumeration', async t => {
  const { stop, checkout, host, slot } = fixture(t);
  checkout.isWorktree = false;
  host.listProcesses = async () => { throw new Error('unexpected process access'); };
  const report = await stop();
  assert.equal(report.isWorktree, false);
  assert.deepEqual(report.stopped, []);
  fs.writeFileSync(slot, '1');
  await assert.rejects(stop({ isolate: true }), /slot/);
});

test('a recycled parent PID and inaccessible termination never produce a successful stop', async t => {
  const { stop, host, processes } = fixture(t);
  processes.find(p => p.pid === 100).created = '99999999';
  host.terminateTree = async () => { throw new Error('process identity changed'); };
  const report = await stop();
  assert.deepEqual(report.stopped.map(p => p.killedRootPid), [101]);
  assert.deepEqual(report.remainingPids.sort(), [101, 102]);
  assert.deepEqual(report.remaining, [4200]);
  assert.deepEqual(report.terminationErrors.map(e => e.pid).sort(), [101, 102]);
});

test('reports an owned browser with an unreadable creation time before attempting termination', async t => {
  const { stop, calls, processes } = fixture(t);
  processes.find(p => p.pid === 102).created = null;
  const report = await stop({ ports: [] });
  assert.deepEqual(calls, []);
  assert.deepEqual(report.skipped.map(p => p.pid), [102]);
  assert.deepEqual(report.terminationErrors.map(p => p.pid), [102]);
});

test('a service that also listens on a wildcard or another slot is preserved even if that port was not requested', async t => {
  const { stop, calls, listeners } = fixture(t);
  listeners.push({ address: '0.0.0.0', port: 5001, pid: 101 });
  const report = await stop({ dryRun: true });
  assert.deepEqual(report.stopped, []);
  assert.ok(report.skipped.some(p => p.pid === 101 && p.port === 4200));
  assert.deepEqual(calls, []);
});

test('stops an owned child without killing the shared launcher or its other-worktree listener', async t => {
  const { stop, calls, listeners, processes } = fixture(t);
  processes.find(p => p.pid === 105).parentPid = 100;
  listeners.push({ address: '127.0.0.8', port: 5432, pid: 105 });
  const report = await stop();
  assert.deepEqual(report.stopped.map(p => p.killedRootPid), [101]);
  assert.deepEqual(calls, [[102, '100102'], [101, '100101']]);
  assert.deepEqual(report.remaining, []);
});
