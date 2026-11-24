import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openWorktreeMcp } from '../scripts/lib/worktree-mcp.mjs';

test('legacy MCP modules retain their named exports', { skip: !process.features.require_module }, async () => {
  for (const [moduleName, names] of [
    ['probe-mcp-route', ['main', 'readManifest', 'startProbe', 'validateIsolation']],
    ['worktree-mcp-session', ['main']],
  ]) {
    const esm = await import('../scripts/' + moduleName + '.mjs');
    const bridge = await import('../scripts/' + moduleName + '.cjs');
    for (const name of names) assert.equal(bridge[name], esm[name]);
  }
});

test('invalid isolation manifest fails before starting MCP', async () => {
  await assert.rejects(openWorktreeMcp({ preflight: { isolated: false } }), /isolated prepare-worktree-mcp manifest/);
});

test('worktree session starts the configured installed CLI directly and forwards storage state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd direct mcp-'));
  const ip = '127.0.0.4';
  const configPath = path.join(root, 'mcp config.json');
  const storagePath = path.join(root, 'storage state.json');
  const mcpCli = path.join(root, 'installed cli.mjs');
  fs.writeFileSync(configPath, JSON.stringify({ browser: { browserName: 'chromium', isolated: true,
    launchOptions: { args: ['--host-resolver-rules=MAP localhost ' + ip] } } }));
  fs.writeFileSync(storagePath, '{}');
  fs.writeFileSync(mcpCli, `
    import assert from 'node:assert/strict';
    import readline from 'node:readline';
    import http from 'node:http';
    assert.deepEqual(process.argv.slice(2), ${JSON.stringify(['--config', configPath, '--storage-state', storagePath])});
    const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (method === 'initialize') reply(id, {});
      if (params?.name === 'browser_navigate') {
        const url = new URL(params.arguments.url);
        const host = url.host;
        url.hostname = '${ip}';
        http.get(url, { headers: { host } }, response => {
          response.resume();
          response.on('end', () => reply(id, { status: response.statusCode }));
        });
      }
      if (params?.name === 'browser_close') reply(id, {});
    });
  `);
  const manifest = { isolationId: 'bdd-mcp-' + 'b'.repeat(32), preflight: { ip, root, isolated: true },
    mcpCli, configPath, server: { command: 'npx',
      args: ['--offline', '--no-install', '@playwright/mcp@latest', '--config', configPath, '--storage-state', storagePath] } };
  let session;
  try {
    await assert.rejects(openWorktreeMcp({ ...manifest, mcpCli: 'relative.mjs' }), /absolute Playwright MCP CLI/);
    await assert.rejects(openWorktreeMcp({ ...manifest, mcpCli: path.join(root, 'missing.mjs') }), /missing or empty/);
    session = await openWorktreeMcp(manifest);
    assert.equal(session.probe.matched.ip, ip);
    assert.equal(session.probe.matched.isolationId, manifest.isolationId);
  } finally {
    await session?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function request(url, host = url.host) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: host } }, async response => {
      try {
        let body = '';
        response.setEncoding('utf8');
        for await (const chunk of response) body += chunk;
        resolve({ status: response.statusCode, headers: response.headers, body });
      } catch (error) {
        reject(error);
      }
    }).on('error', reject);
  });
}

test('probe requires the current localhost challenge on the isolated listener', { timeout: 10000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-route-probe-'));
  const manifest = path.join(directory, 'prepared.json');
  const isolationId = 'bdd-mcp-' + 'a'.repeat(32);
  const ip = '127.0.0.4';
  fs.writeFileSync(manifest, JSON.stringify({ isolationId, preflight: { isolated: true, ip } }));
  const script = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, 'mcp-probe', manifest], { windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  const lines = readline.createInterface({ input: child.stdout });
  try {
    const output = lines[Symbol.asyncIterator]();
    const ready = await output.next();
    if (ready.done) {
      await closed;
      assert.fail('Probe exited without a ready event. ' + stderr.trim());
    }
    const { url, status } = JSON.parse(ready.value);
    assert.equal(status, 'ready');
    const probeUrl = new URL(url);
    assert.equal(probeUrl.hostname, 'localhost');
    const directUrl = new URL(url);
    directUrl.hostname = ip;
    assert.equal((await request(directUrl)).status, 404);
    assert.equal((await request(new URL('/wrong', directUrl), probeUrl.host)).status, 404);
    const response = await request(directUrl, probeUrl.host);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const expected = { status: 'matched', isolationId, ip, port: Number(probeUrl.port) };
    assert.deepEqual(JSON.parse(response.body), expected);
    assert.deepEqual(JSON.parse((await output.next()).value), expected);
    assert.deepEqual(await closed, [0, null]);
  } finally {
    child.kill();
    await closed;
    lines.close();
    fs.unlinkSync(manifest);
    fs.rmdirSync(directory);
  }
});
