import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { runPlaywrightCli } from '../scripts/lib/worktree-cli.mjs';

const fixture = fileURLToPath(new URL('./quality-fixture.mjs', import.meta.url));

async function runMode(mode, directory, url, db, expectedState) {
  const start = performance.now();
  let calls = 0;
  const session = 'bdd-bench-' + randomUUID();
  const ui = (...args) => {
    calls++;
    return runPlaywrightCli(session, args, { cwd: directory });
  };
  const go = 'await page.goto(' + JSON.stringify(url) + ');';
  const title = "if(await page.getByRole('heading').innerText()!=='Order 1')throw Error('heading');";
  const state = "if(await page.getByRole('status').innerText()!==" + JSON.stringify(expectedState) + ")throw Error('state');";

  try {
    await ui('open');
    try {
      if (mode === 'separate') {
        await ui('goto', url);
        for (const check of [title, state]) await ui('run-code', 'async page=>{' + check + '}');
      } else {
        await ui('run-code', 'async page=>{' + go + title + state + '}');
      }
    } finally {
      await ui('close');
    }
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
      mode, ms: Math.round(performance.now() - start), cliCalls: calls,
      assertions: ['heading', 'state', 'status', 'schema', 'body', 'db'], status: 'PASSED', tokens: null,
    }));
  } catch (error) {
    console.log(JSON.stringify({ mode, ms: Math.round(performance.now() - start), cliCalls: calls, status: 'FAILED', error: error.message }));
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
  try {
    const lines = createInterface({ input: server.stdout });
    const [port] = await Promise.race([
      once(lines, 'line'),
      once(server, 'exit').then(([code]) => { throw new Error('Fixture exited before startup with ' + code); }),
    ]);
    const url = 'http://127.0.0.1:' + port;
    for (const mode of requested ? [requested] : ['separate', 'batch', 'batch', 'separate', 'separate', 'batch']) {
      await runMode(mode, directory, url, db, expectedState);
    }
  } finally {
    server.kill();
    await serverClosed;
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

try {
  await benchmark();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
