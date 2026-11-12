const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const test = require('node:test');
const { openWorktreeMcp } = require('../scripts/lib/worktree-mcp.cjs');

test('invalid isolation manifest fails before starting MCP', async () => {
  await assert.rejects(openWorktreeMcp({ preflight: { isolated: false } }), /isolated prepare-worktree-mcp manifest/);
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
  const script = path.join(__dirname, '../scripts/probe-mcp-route.cjs');
  const child = spawn(process.execPath, [script, manifest], { windowsHide: true });
  const closed = once(child, 'close');
  const lines = readline.createInterface({ input: child.stdout });
  try {
    const output = lines[Symbol.asyncIterator]();
    const ready = await output.next();
    assert.equal(ready.done, false, 'probe must publish a ready event');
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
