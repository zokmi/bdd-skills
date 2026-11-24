import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./quality-fixture.mjs', import.meta.url));

function launchMcp(directory) {
  const child = spawn(process.env.ComSpec, [
    '/d', '/s', '/c', 'npm exec --offline --yes --package=@playwright/mcp@0.0.84 -- playwright-mcp --headless --isolated',
  ], { cwd: directory, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let id = 0;
  let failure;

  function fail(error) {
    failure ??= error;
    for (const request of pending.values()) request.reject(failure);
  }
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    fail(new Error('MCP exited with ' + (signal ?? code)));
    resolve();
  }));
  child.on('error', fail);
  child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      pending.get(message.id)?.resolve(message);
    } catch (error) {
      fail(error);
    }
  });

  function send(message) {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  async function rpc(method, params) {
    const key = ++id;
    let timer;
    try {
      const reply = await new Promise((resolve, reject) => {
        pending.set(key, { resolve, reject });
        timer = setTimeout(() => reject(new Error(method + ' timeout')), 45000);
        send({ id: key, method, params });
      });
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    } finally {
      clearTimeout(timer);
      pending.delete(key);
    }
  }

  return {
    rpc,
    notify: method => send({ method }),
    async close() {
      child.stdin.end();
      await closed;
      lines.close();
    },
  };
}

async function runMode(mode, mcp, url, db, expectedState) {
  const start = performance.now();
  let calls = 0;
  async function ui(name, args) {
    calls++;
    const result = await mcp.rpc('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
  }
  const go = 'await page.goto(' + JSON.stringify(url) + ');';
  const title = "if(await page.getByRole('heading').innerText()!=='Order 1')throw Error('heading');";
  const state = "if(await page.getByRole('status').innerText()!==" + JSON.stringify(expectedState) + ")throw Error('state');";

  try {
    if (mode === 'separate') {
      await ui('browser_navigate', { url });
      for (const check of [title, state]) await ui('browser_run_code_unsafe', { code: 'async page=>{' + check + '}' });
    } else {
      await ui('browser_run_code_unsafe', { code: 'async page=>{' + go + title + state + '}' });
    }
    await ui('browser_close', {});
    const response = await fetch(url + '/api/orders/1');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await response.json(), { id: 1, state: 'paid' });

    const query = spawn(process.execPath, [fixture, 'read', db]);
    let output = '';
    query.stdout.on('data', chunk => { output += chunk; });
    assert.equal((await once(query, 'close'))[0], 0);
    assert.deepEqual(JSON.parse(output), { id: 1, state: 'paid' });
    console.log(JSON.stringify({
      mode, ms: Math.round(performance.now() - start), mcpCalls: calls,
      assertions: ['heading', 'state', 'status', 'schema', 'body', 'db'], status: 'PASSED', tokens: null,
    }));
  } catch (error) {
    console.log(JSON.stringify({ mode, ms: Math.round(performance.now() - start), mcpCalls: calls, status: 'FAILED', error: error.message }));
    process.exitCode = 1;
  }
}

async function benchmark() {
  const requested = process.argv[2];
  assert.ok(!requested || ['separate', 'batch'].includes(requested));
  const expectedState = process.argv[3] === 'wrong-state' ? 'pending' : 'paid';
  const directory = mkdtempSync(join(tmpdir(), 'bdd-compare-'));
  const db = join(directory, 'orders.sqlite');
  const server = spawn(process.execPath, [fixture, 'serve', db]);
  const serverClosed = new Promise(resolve => server.once('close', resolve));
  let mcp;
  try {
    const lines = createInterface({ input: server.stdout });
    const [port] = await Promise.race([
      once(lines, 'line'),
      once(server, 'exit').then(([code]) => { throw new Error('Fixture exited before startup with ' + code); }),
    ]);
    const url = 'http://127.0.0.1:' + port;
    mcp = launchMcp(directory);
    await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bdd-fixture', version: '1' } });
    mcp.notify('notifications/initialized');
    for (const mode of requested ? [requested] : ['separate', 'batch', 'batch', 'separate', 'separate', 'batch']) {
      await runMode(mode, mcp, url, db, expectedState);
    }
  } finally {
    server.kill();
    await Promise.all([serverClosed, mcp?.close()]);
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

try {
  await benchmark();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
