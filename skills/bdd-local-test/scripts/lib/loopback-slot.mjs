import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { git } from './verification-git.mjs';
import { listListeners, processNames, withAllocationLocks } from './windows-host.mjs';

export function parsePorts(values = []) {
  const tokens = [values].flat().flatMap(value => String(value).split(/[,\s]+/)).filter(Boolean);
  return tokens.map(token => {
    const port = Number(token);
    if (!/^\d+$/.test(token) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Ports 必須是專案原有埠號（1..65535）');
    }
    return port;
  });
}

export function worktreeInfo() {
  const out = git('.', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  const [root, gitPath, commonPath] = out.trimEnd().split(/\r?\n/);
  const gitDir = fs.realpathSync.native(gitPath);
  const commonDir = fs.realpathSync.native(commonPath);
  return { root, gitDir, commonDir, isWorktree: Boolean(path.relative(gitDir, commonDir)) };
}

const marker = 'bdd-loopback-slot';
const validSlot = n => Number.isInteger(n) && n >= 2 && n <= 254;
const dirKey = dir => process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function readSlot(dir) {
  const raw = readOptional(path.join(dir, marker));
  if (raw === null) return null;
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !validSlot(n)) throw new Error('無效的 worktree slot：' + dir);
  return n;
}

function readRegistry(file) {
  const raw = readOptional(file);
  const data = raw === null ? { version: 1, leases: [] } : JSON.parse(raw);
  if (data?.version !== 1 || !Array.isArray(data.leases)) throw new Error('無效的跨 repo slot 登記，停止分配');
  const live = [];
  const owners = new Set();
  const slots = new Set();
  for (const lease of data.leases) {
    if (!lease || !validSlot(lease.slot) || typeof lease.gitDir !== 'string' || !path.isAbsolute(lease.gitDir)) {
      throw new Error('無效的跨 repo slot 登記，停止分配');
    }
    const current = readSlot(lease.gitDir);
    if (current === null) continue;
    if (current !== lease.slot) throw new Error('既有 slot 與跨 repo 登記不一致，未重新分配');
    const owner = dirKey(lease.gitDir);
    if (slots.has(lease.slot) || owners.has(owner)) throw new Error('跨 repo slot 登記重複，停止分配');
    owners.add(owner);
    slots.add(lease.slot);
    live.push(lease);
  }
  return { data, live };
}

function registeredSiblings(commonDir, gitDir) {
  const trees = path.join(commonDir, 'worktrees');
  let entries = [];
  try { entries = fs.readdirSync(trees, { withFileTypes: true }); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const dirs = [commonDir, ...entries.filter(e => e.isDirectory()).map(e => path.join(trees, e.name))];
  return dirs.filter(dir => dirKey(dir) !== dirKey(gitDir)).map(readSlot).filter(n => n !== null);
}

async function reserve(info, registry, listeners) {
  const { commonDir, gitDir } = info;
  const directory = path.dirname(registry);
  fs.mkdirSync(directory, { recursive: true });
  return withAllocationLocks(directory, commonDir, async publish => {
    const { data, live } = readRegistry(registry);
    const siblings = registeredSiblings(commonDir, gitDir);
    const own = dirKey(gitDir);
    const existing = readSlot(gitDir);
    let slot = existing;
    if (slot === null) {
      const used = new Set([...live.map(lease => lease.slot), ...siblings]);
      const addresses = new Set((await listeners()).map(l => l.address));
      for (let n = 2; n <= 254; n++) {
        if (!used.has(n) && !addresses.has('127.0.0.' + n)) { slot = n; break; }
      }
      if (slot === null) throw new Error('127.0.0.2 ~ 127.0.0.254 都已被分配，請清理不用的 worktree');
    }
    if (siblings.includes(slot)) throw new Error('worktree slot ' + slot + ' 重複，停止測試並確認既有服務歸屬');
    if (live.some(lease => lease.slot === slot && dirKey(lease.gitDir) !== own)) {
      throw new Error('跨 repo slot ' + slot + ' 已由其他工作區預約，停止並確認既有服務歸屬');
    }
    const count = data.leases.length;
    const alreadyReserved = live.some(lease => dirKey(lease.gitDir) === own);
    if (!alreadyReserved) live.push({ gitDir, slot });
    const registryJson = !alreadyReserved || live.length !== count
      ? JSON.stringify({ ...data, leases: live }, null, 2) : null;
    // Only the owner of both OS locks may publish the reservation and marker.
    await publish({ gitDir, registryJson, slot: existing === null ? slot : null });
    return slot;
  });
}

async function bind(host, port) {
  const server = net.createServer(socket => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

const close = server => new Promise(resolve => server.close(resolve));

async function mapPorts(ip, ports, occupied, allowFallback) {
  const requested = new Set(ports);
  const busy = new Set(occupied.map(l => l.port));
  const held = [];
  const mappings = [];
  try {
    for (const originalPort of requested) {
      let effectivePort = originalPort;
      if (allowFallback && !busy.has(originalPort)) {
        try { held.push(await bind(ip, originalPort)); }
        catch (err) {
          if (!['EACCES', 'EADDRINUSE'].includes(err.code)) throw err;
          busy.add(originalPort);
        }
      }
      if (allowFallback && busy.has(originalPort)) {
        effectivePort = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          const server = await bind(ip, 0);
          const candidate = server.address().port;
          if (!requested.has(candidate)) {
            held.push(server);
            effectivePort = candidate;
            break;
          }
          await close(server);
        }
        if (effectivePort === null) throw new Error('無法為 ' + ip + ':' + originalPort + ' 分配臨時埠');
      }
      mappings.push({ originalPort, effectivePort });
    }
  } finally { await Promise.all(held.map(close)); }
  return mappings;
}

export async function allocateSlot({ ports = [], isolate = false, keepOriginalPorts = false } = {}) {
  const portList = parsePorts(ports);
  const info = worktreeInfo();
  const isolated = info.isWorktree || isolate;
  let snapshot;
  const listeners = () => snapshot ??= listListeners();
  let registryPath = null;
  let slot = 1;
  if (isolated) {
    const directory = process.env.BDD_LOOPBACK_REGISTRY_DIR || path.join(os.homedir(), '.bdd-loopback', 'registry-v1');
    registryPath = path.resolve(directory, 'reservations.json');
    slot = await reserve(info, registryPath, listeners);
  }
  const ip = '127.0.0.' + slot;
  const occupied = [];
  if (portList.length) {
    const matches = (await listeners()).filter(l => [ip, '0.0.0.0', '::'].includes(l.address) && portList.includes(l.port));
    const names = matches.length ? await processNames([...new Set(matches.map(l => l.pid))]) : new Map();
    for (const port of portList) {
      for (const l of matches.filter(l => l.port === port)) occupied.push({ ...l, process: names.get(l.pid) ?? null });
    }
  }
  const portMappings = await mapPorts(ip, portList, occupied, isolated && !keepOriginalPorts);
  const chromiumArg = isolated ? '--host-resolver-rules=MAP localhost ' + ip : '';
  const profile = path.join(os.tmpdir(), 'bdd-chrome-slot' + slot);
  return {
    slot, ip, isWorktree: info.isWorktree, isolated, registryPath, root: info.root, chromiumArg,
    chromeCommand: isolated ? 'chrome.exe --user-data-dir="' + profile + '" "' + chromiumArg + '"' : '',
    occupied, portMappings, effectivePorts: portMappings.map(p => p.effectivePort),
  };
}

export async function loopbackCommand(args) {
  const { values } = parseArgs({ args, options: {
    ports: { type: 'string', multiple: true }, isolate: { type: 'boolean' }, 'keep-original-ports': { type: 'boolean' },
  } });
  const result = await allocateSlot({ ports: values.ports, isolate: values.isolate, keepOriginalPorts: values['keep-original-ports'] });
  console.log(JSON.stringify(result));
  return 0;
}
