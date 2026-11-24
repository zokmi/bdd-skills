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
import { openWorktreeCli } from '../scripts/lib/worktree-cli.mjs';

test('invalid isolation manifest fails before starting the CLI', async () => {
  await assert.rejects(openWorktreeCli({ preflight: { isolated: false } }), /isolated prepare-worktree-cli manifest/);
});

test('one named CLI session probes before restoring state and reports command errors', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd direct cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ip = '127.0.0.4';
  const isolationId = 'bdd-cli-' + 'b'.repeat(32);
  const configPath = path.join(root, 'cli config.json');
  const storageState = path.join(root, 'storage state.json');
  const cliPath = path.join(root, 'installed cli.mjs');
  fs.writeFileSync(configPath, JSON.stringify({ browser: { browserName: 'chromium', isolated: true,
    launchOptions: { args: ['--host-resolver-rules=MAP localhost ' + ip] } } }));
  fs.writeFileSync(storageState, '{}');
  fs.writeFileSync(cliPath, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import http from 'node:http';
    const args = process.argv.slice(2);
    assert.equal(args.shift(), '-s=${isolationId}');
    assert.equal(args.pop(), '--json');
    fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
    if (args[0] === 'goto') {
      const url = new URL(args[1]);
      const host = url.host;
      url.hostname = '${ip}';
      await new Promise((resolve, reject) => http.get(url, { headers: { host } }, response => {
        response.resume(); response.on('end', resolve);
      }).on('error', reject));
    }
    if (args[0] === 'click') {
      console.log(JSON.stringify({ isError: true, error: 'missing ref' }));
      process.exitCode = 1;
    } else if (args[0] === 'list') {
      const browsers = fs.existsSync('active') ? [{ name: '${isolationId}' }] : [];
      console.log(JSON.stringify({ browsers }));
    } else if (args[0] === 'state-load' && !fs.existsSync(args[1])) {
      console.log(JSON.stringify({ isError: true, error: 'missing storage state' }));
      process.exitCode = 1;
    } else console.log(JSON.stringify({ result: 'done' }));
  `);
  const manifest = { isolationId, preflight: { ip, root, isolated: true }, configPath, cliPath, storageState };
  await assert.rejects(openWorktreeCli({ ...manifest, cliPath: 'relative.mjs' }), /absolute/);
  await assert.rejects(openWorktreeCli({ ...manifest, cliPath: path.join(root, 'missing.mjs') }), /missing or empty/);
  await assert.rejects(openWorktreeCli({ ...manifest, preflight: { ...manifest.preflight, ip: '127.0.0.5' } }), /resolver/);
  const session = await openWorktreeCli(manifest);
  try {
    assert.equal(session.probe.matched.ip, ip);
    assert.equal(session.probe.matched.isolationId, isolationId);
    await assert.rejects(session.run('click', 'e1'), /missing ref/);
    assert.deepEqual(await session.run('snapshot'), { result: 'done' });
  } finally { await session.close(); }
  assert.equal(session.closed(), true);
  const logPath = path.join(root, 'calls.jsonl');
  const calls = () => fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls(), [['list'], ['open', '--config=' + configPath], ['goto', session.probe.ready.url],
    ['state-load', storageState], ['click', 'e1'], ['snapshot'], ['close']]);
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(path.join(root, 'active'), '');
  await assert.rejects(openWorktreeCli(manifest), /already open/);
  assert.deepEqual(calls(), [['list']]);

  fs.unlinkSync(path.join(root, 'active'));
  fs.unlinkSync(storageState);
  await assert.rejects(openWorktreeCli(manifest), /missing storage state/);
  assert.deepEqual(calls().slice(-2), [['state-load', storageState], ['close']]);
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
  const isolationId = 'bdd-cli-' + 'a'.repeat(32);
  const ip = '127.0.0.4';
  fs.writeFileSync(manifest, JSON.stringify({ isolationId, preflight: { isolated: true, ip } }));
  const script = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, 'cli-probe', manifest], { windowsHide: true });
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
