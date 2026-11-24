import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { parsePorts, worktreeInfo } from './loopback-slot.mjs';

const browserName = /^(chrome|chromium|msedge)(\.exe)?$/i;
const launcherName = /^(node|dotnet)(\.exe)?$/i;

// Windows argv quoting: a pair of backslashes before a quote encodes one
// backslash; an odd final backslash escapes the quote itself.
function argumentsOf(commandLine) {
  const args = [];
  let token = '', quoted = false;
  for (const part of (commandLine || '').match(/\\*"|[^ \t"\\]+|\\+|[ \t]+/g) || []) {
    if (part.endsWith('"')) {
      const slashes = part.length - 1;
      token += '\\'.repeat(Math.floor(slashes / 2));
      if (slashes % 2) token += '"';
      else quoted = !quoted;
    } else if (!quoted && /^[ \t]/.test(part)) {
      if (token) args.push(token);
      token = '';
    } else token += part;
  }
  if (quoted) return [];
  if (token) args.push(token);
  return args;
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function ownedPath(root, candidate) {
  if (!candidate || !path.isAbsolute(candidate) || !inside(root, candidate)) return false;
  try { return inside(root, fs.realpathSync.native(candidate)); }
  catch { return false; }
}

function ownedService(root, proc) {
  if (!proc || browserName.test(proc.name)) return false;
  if (ownedPath(root, proc.executablePath)) return true;
  return argumentsOf(proc.commandLine).some(arg =>
    ownedPath(root, arg.replace(/^--?[\w-]+=/, '')));
}

function browserProfile(root, proc) {
  if (!browserName.test(proc.name)) return undefined;
  const args = argumentsOf(proc.commandLine);
  if (args.some(arg => /^--type(?:=|$)/i.test(arg))) return undefined;
  const profiles = [];
  for (const [i, arg] of args.entries()) {
    if (/^--user-data-dir=/i.test(arg)) profiles.push(arg.slice(arg.indexOf('=') + 1));
    else if (/^--user-data-dir$/i.test(arg)) profiles.push(args[i + 1]);
  }
  return profiles.length === 1 && ownedPath(root, profiles[0]) ? profiles[0] : null;
}

function identifiable(proc) {
  return proc && proc.pid > 0 && /^[1-9]\d*$/.test(proc.created);
}

// Ending a tree also ends its siblings' descendants when a launcher is shared.
// Protect the foreign listener and each ancestor before choosing any kill root.
function protectedTrees(processes, pids) {
  const blocked = new Set();
  for (const pid of pids) {
    let proc = processes.get(pid);
    while (proc && !blocked.has(proc.pid)) {
      blocked.add(proc.pid);
      proc = processes.get(proc.parentPid);
    }
  }
  return blocked;
}

function launcher(root, proc, processes, protectedPids) {
  const visited = new Set([proc.pid]);
  let top = proc;
  for (;;) {
    const parent = processes.get(top.parentPid);
    if (!identifiable(parent) || protectedPids.has(parent.pid) || visited.has(parent.pid) || BigInt(parent.created) > BigInt(top.created) ||
        !launcherName.test(parent.name) || !ownedService(root, parent)) return top;
    visited.add(parent.pid);
    top = parent;
  }
}

export async function stopSlotServices(checkout, { ports, dryRun, isolate }, host) {
  const { isWorktree } = checkout;
  if (!isWorktree && !isolate) {
    return { isWorktree, ip: '127.0.0.1', stopped: [], skipped: [], remaining: [], message: '主目錄不是 worktree，不停止任何服務' };
  }
  const slotFile = path.join(checkout.gitDir, 'bdd-loopback-slot');
  const slot = fs.readFileSync(slotFile, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!/^\d{1,3}$/.test(slot) || Number(slot) < 2 || Number(slot) > 254) throw new Error('無效的隔離 slot，不停止任何程序');
  const root = fs.realpathSync.native(checkout.root);
  const ip = '127.0.0.' + Number(slot);
  const report = { isWorktree, isolated: true, ip, dryRun, stopped: [], browsers: [], skipped: [], remaining: [],
    remainingPids: [], terminationErrors: [] };
  const targets = new Map();
  const processes = new Map((await host.listProcesses()).map(proc => [proc.pid, proc]));
  const foreignBrowsers = [];
  const ownedBrowsers = [];
  for (const proc of processes.values()) {
    const profile = browserProfile(root, proc);
    if (profile) ownedBrowsers.push({ proc, profile });
    else if (profile === null) foreignBrowsers.push(proc.pid);
  }
  const listeners = await host.listListeners();
  const localOwners = new Set(listeners.filter(l => l.address === ip).map(l => l.pid));
  const foreign = listeners.filter(l => l.address !== ip);
  const unownedListeners = listeners.filter(l => l.address !== ip || !ownedService(root, processes.get(l.pid)));
  const protectedServices = protectedTrees(processes, foreignBrowsers.concat(unownedListeners.map(l => l.pid)));
  // A persistent Chromium profile can expose its own debugging endpoint on
  // localhost. A process serving both slot and non-slot addresses is shared.
  const protectedBrowsers = protectedTrees(processes, foreignBrowsers.concat(foreign.filter(l =>
    !['127.0.0.1', '::1'].includes(l.address) || localOwners.has(l.pid) || !browserName.test(processes.get(l.pid)?.name)
  ).map(l => l.pid)));
  for (const { proc, profile } of ownedBrowsers) {
    if (!identifiable(proc) || protectedBrowsers.has(proc.pid)) {
      const reason = identifiable(proc) ? '程序樹另有需要保留的監聽程序或瀏覽器' : '無法核對瀏覽器程序建立時間';
      report.skipped.push({ pid: proc.pid, process: proc.name, profile, reason });
      if (!dryRun) report.terminationErrors.push({ pid: proc.pid, reason });
      continue;
    }
    targets.set(proc.pid, proc);
    report.browsers.push({ pid: proc.pid, process: proc.name, profile });
  }
  for (const { address, port, pid } of listeners.filter(l => ports.includes(l.port))) {
    const proc = processes.get(pid);
    const row = { port, address, pid, process: proc?.name ?? null };
    if (address !== ip) {
      if (address === '0.0.0.0' || address === '::') report.skipped.push({ ...row, reason: '綁全部 IP，非本 worktree 專屬' });
    } else if (identifiable(proc) && ownedService(root, proc) && !protectedServices.has(pid)) {
      const top = launcher(root, proc, processes, protectedServices);
      targets.set(top.pid, top);
      report.stopped.push({ ...row, killedRootPid: top.pid, killedRoot: top.name });
    } else if (!targets.has(pid)) {
      report.skipped.push({ ...row, reason: protectedServices.has(pid) ? '無法安全停止整個程序樹' : '無法確認程序身分或工作區歸屬' });
    }
  }
  function remainingPorts(rows) {
    return [...new Set(rows.filter(l => l.address === ip && ports.includes(l.port)).map(l => l.port))];
  }
  report.remaining = remainingPorts(listeners);
  if (dryRun || !targets.size) return report;
  for (const { pid, created } of targets.values()) {
    try { await host.terminateTree(pid, created); }
    catch (error) { report.terminationErrors.push({ pid, reason: error.message }); }
  }
  const deadline = Date.now() + 2000;
  for (;;) {
    const current = await host.listProcesses();
    report.remainingPids = current.filter(p => targets.has(p.pid) && targets.get(p.pid).created === p.created).map(p => p.pid);
    report.remaining = ports.length ? remainingPorts(await host.listListeners()) : [];
    if (!report.remainingPids.length && !report.remaining.length) break;
    if (report.terminationErrors.length || Date.now() >= deadline) break;
    await delay(100);
  }
  return report;
}

export async function stopSlotCommand(args) {
  const { values } = parseArgs({ args, options: {
    ports: { type: 'string', multiple: true }, isolate: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  } });
  const options = { ports: parsePorts(values.ports || []), dryRun: Boolean(values['dry-run']), isolate: Boolean(values.isolate) };
  const report = await stopSlotServices(worktreeInfo(), options, await import('./windows-host.mjs'));
  console.log(JSON.stringify(report));
  return !options.dryRun && (report.remaining.length || report.remainingPids?.length || report.terminationErrors?.length) ? 1 : 0;
}
