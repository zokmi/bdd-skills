const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { readManifest, startProbe, validateIsolation } = require('../probe-mcp-route.cjs');

function launchSpec(manifest, mcpCli) {
  const { configPath, server, preflight } = manifest;
  const args = server?.args;
  const configIndex = args?.[0] === '--offline' ? 3 : 2;
  const mcpArgs = Array.isArray(args) ? args.slice(configIndex) : [];
  const npmArgs = configIndex === 3 ? ['--offline', '--no-install', '@playwright/mcp@latest'] : ['--no-install', '@playwright/mcp'];
  if (!path.isAbsolute(configPath ?? '') || server?.command !== 'npx' || !Array.isArray(args) ||
      npmArgs.some((arg, index) => args[index] !== arg) || mcpArgs[0] !== '--config' || mcpArgs[1] !== configPath ||
      !(mcpArgs.length === 2 || (mcpArgs.length === 4 && mcpArgs[2] === '--storage-state' && path.isAbsolute(mcpArgs[3] ?? '')))) {
    throw new Error('Expected the generated Playwright MCP command and absolute config path');
  }
  const config = readManifest(configPath);
  const browser = config.browser;
  const resolver = '--host-resolver-rules=MAP localhost ' + preflight.ip;
  const launchArgs = browser?.launchOptions?.args;
  if (browser?.browserName !== 'chromium' || browser.isolated !== true || !Array.isArray(launchArgs) ||
      launchArgs.filter(arg => arg.startsWith('--host-resolver-rules')).join('') !== resolver) {
    throw new Error('Playwright MCP config does not match the allocated localhost resolver');
  }
  if (mcpCli) return [process.execPath, [path.resolve(mcpCli), ...mcpArgs]];
  if (process.platform !== 'win32') return ['npx', args];

  // Invoke the npm entry point with argv intact, including Windows paths with spaces.
  const directories = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  const npxCli = directories.map(dir => path.join(dir, 'node_modules/npm/bin/npx-cli.js')).find(file => fs.existsSync(file));
  if (!npxCli) throw new Error('Cannot locate npx-cli.js. Supply the installed Playwright MCP cli.js path.');
  return [process.execPath, [npxCli, ...args]];
}

function connect(command, args, cwd, tempDir) {
  const env = { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir };
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let failure;
  let stderr = '';
  let closing;
  const exited = new Promise(resolve => child.once('close', resolve));
  function fail(error) {
    failure ??= error;
    for (const item of pending.values()) item.reject(failure);
    pending.clear();
  }
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
  child.once('exit', (code, signal) => fail(new Error(`Playwright MCP exited (${code ?? signal}) ${stderr}`)));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let reply;
    try { reply = JSON.parse(line); } catch { return; }
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    if (reply.error) item.reject(new Error(JSON.stringify(reply.error)));
    else item.resolve(reply.result);
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  async function rpc(method, params, timeout = 45000) {
    if (failure) throw failure;
    const id = ++nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Playwright MCP ${method} timed out ${stderr}`)), timeout);
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  return {
    rpc,
    async initialize() {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bdd-local-test', version: '1.0' } });
      send({ method: 'notifications/initialized' });
    },
    closed: () => child.exitCode !== null || child.signalCode !== null,
    close() {
      closing ??= (async () => {
        try { await rpc('tools/call', { name: 'browser_close', arguments: {} }, 3000); } catch {}
        child.stdin.end();
        await Promise.race([exited, delay(3000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        lines.close();
      })();
      return closing;
    },
  };
}

async function openWorktreeMcp(manifest, { cwd = manifest?.preflight?.root, mcpCli } = {}) {
  validateIsolation(manifest);
  const [command, args] = launchSpec(manifest, mcpCli);
  // Keep Chrome's temporary files within the current run, including in a Windows app sandbox.
  const tempDir = fs.mkdtempSync(path.join(path.dirname(manifest.configPath), 'bdd-mcp-temp-'));
  let connection;
  let closing;
  function close() {
    closing ??= (async () => {
      await connection?.close();
      await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    })();
    return closing;
  }
  async function call(name, args = {}) {
    if (name === 'browser_close') throw new Error('Use session.close() to close the isolated browser and MCP');
    const result = await connection.rpc('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(`Playwright MCP ${name}: ${JSON.stringify(result)}`);
    return result;
  }
  try {
    connection = connect(command, args, cwd, tempDir);
    await connection.initialize();
    const probe = await startProbe(manifest);
    try {
      await call('browser_navigate', { url: probe.ready.url });
      const matched = await probe.matched;
      if (!matched) throw new Error('Playwright MCP did not reach the allocated localhost IP');
      return {
        call,
        listTools: () => connection.rpc('tools/list', {}),
        close,
        closed: connection.closed,
        probe: { ready: probe.ready, matched },
      };
    } finally {
      probe.close();
    }
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { openWorktreeMcp, readManifest };
