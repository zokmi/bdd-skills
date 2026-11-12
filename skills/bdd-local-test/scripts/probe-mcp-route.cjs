const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { isIPv4 } = require('node:net');

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
}

function validateIsolation({ isolationId, preflight }) {
  const ip = preflight?.ip;
  const slot = isIPv4(ip) ? Number(ip.split('.')[3]) : 0;
  if (preflight?.isolated !== true || !isIPv4(ip) || !ip.startsWith('127.0.0.') || slot < 2 || slot > 254 ||
      typeof isolationId !== 'string' || !/^bdd-mcp-[a-f0-9]{32}$/.test(isolationId)) {
    throw new Error('Expected an isolated prepare-worktree-mcp manifest');
  }
}

async function startProbe(manifest) {
  validateIsolation(manifest);
  const { isolationId, preflight: { ip } } = manifest;
  const route = '/bdd-mcp-probe/' + randomUUID();
  let finish;
  const matched = new Promise(resolve => { finish = resolve; });
  let timeout;
  function close(evidence = null) {
    clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
    finish(evidence);
  }
  const server = http.createServer((req, res) => {
    const { localAddress, localPort } = req.socket;
    res.setHeader('Connection', 'close');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' || req.url !== route || req.headers.host !== 'localhost:' + localPort ||
        localAddress !== ip) {
      res.writeHead(404).end();
      return;
    }

    const evidence = { status: 'matched', isolationId, ip: localAddress, port: localPort };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(evidence), () => close(evidence));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, ip, resolve);
  });
  timeout = setTimeout(close, 60000);
  const { port } = server.address();
  return { ready: { status: 'ready', isolationId, ip, port, url: 'http://localhost:' + port + route }, matched, close };
}

async function main() {
  const probe = await startProbe(readManifest(process.argv[2]));
  console.log(JSON.stringify(probe.ready));
  const evidence = await probe.matched;
  if (!evidence) throw new Error('Timed out waiting for the localhost request from Playwright MCP');
  console.log(JSON.stringify(evidence));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { readManifest, startProbe, validateIsolation };
