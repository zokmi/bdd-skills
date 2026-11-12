// No browser automation dependency: all page operations go through independent
// stdio Playwright MCP servers, using the generated localhost resolver configs.
const fs = require('node:fs');
const http = require('node:http');
const { openWorktreeMcp } = require('../scripts/lib/worktree-mcp.cjs');
const path = require('node:path');
const assert = require('node:assert/strict');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const { uiPort, apiPort } = manifest;
const uiOrigin = 'http://localhost:' + uiPort;
const apiOrigin = 'http://localhost:' + apiPort;
const listeners = [], clients = [], hits = [], checks = [];
function listen(service, port, api) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const hit = { id: service.id, api, url: req.url, host: req.headers.host,
        origin: req.headers.origin, localAddress: req.socket.localAddress, localPort: req.socket.localPort };
      hits.push(hit);
      res.setHeader('Cache-Control', 'no-store');
      if (api) {
        assert.equal(req.socket.localPort, apiPort);
        res.setHeader('Access-Control-Allow-Origin', uiOrigin);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: service.id, ip: req.socket.localAddress, port: req.socket.localPort }));
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><title>${service.id}</title><h1>${service.id}</h1><pre id="result">loading</pre>
          <script>fetch('${apiOrigin}/api/identity').then(r=>r.json()).then(api=>{
          window.identity={ui:${JSON.stringify(service.id)},api};
          document.querySelector('#result').textContent=JSON.stringify(window.identity);
          }).catch(e=>document.querySelector('#result').textContent=String(e));</script>`);
      }
    });
    server.on('error', reject);
    server.listen(port, service.ip, () => { listeners.push(server); resolve(); });
  });
}
async function evaluate(client, fn) {
  const result = await client.call('browser_evaluate', { function: fn });
  const content = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { result, content };
}

(async () => {
  try {
    // All six instances listen simultaneously on exactly the same two ports.
    await Promise.all(manifest.services.flatMap(s => [listen(s, uiPort, false), listen(s, apiPort, true)]));
    const connections = await Promise.allSettled(manifest.services.map(async service => {
      const session = await openWorktreeMcp(service.prepared, { mcpCli: manifest.mcpCli });
      const client = { service, ...session };
      clients.push(client);
      fs.writeFileSync(path.join(manifest.outputDir, service.id, 'probe-evidence.json'), JSON.stringify(session.probe, null, 2));
      return client;
    }));
    const failed = connections.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const connected = connections.map(result => result.value);
    await Promise.all(connected.map(async client => {
      const { service } = client;
      const navigation = await client.call('browser_navigate', { url: uiOrigin + '/' });
      await client.call('browser_wait_for', { text: '"port":' + apiPort });
      const evidence = await evaluate(client, `async () => {
        const api = await fetch('${apiOrigin}/api/recheck').then(r=>r.json());
        if (window.identity.ui !== ${JSON.stringify(service.id)} || api.id !== ${JSON.stringify(service.id)}) throw new Error('cross-routed identity');
        if (api.port !== ${apiPort} || api.ip !== ${JSON.stringify(service.ip)}) throw new Error('API IP/port changed');
        localStorage.setItem('instance', ${JSON.stringify(service.id)});
        document.cookie='instance=${service.id}; SameSite=Lax';
        return {url: location.href, identity: window.identity, api, userAgent: navigator.userAgent};
      }`);
      fs.writeFileSync(path.join(manifest.outputDir, service.id, 'navigation.json'), JSON.stringify(navigation, null, 2));
      fs.writeFileSync(path.join(manifest.outputDir, service.id, 'browser-evidence.json'), JSON.stringify(evidence.result, null, 2));
      checks.push({ id: service.id, ip: service.ip, uiPort, apiPort, isolationId: service.isolationId, status: 'passed' });
    }));
    // Recheck after every browser has written to the same localhost origin.
    await Promise.all(connected.map(client => evaluate(client, `() => {
      if(localStorage.getItem('instance') !== ${JSON.stringify(client.service.id)} || !document.cookie.includes('instance=${client.service.id}')) throw new Error('browser storage leaked');
      return 'isolated';
    }`)));
    for (const service of manifest.services) {
      const apiHits = hits.filter(h => h.id === service.id && h.api);
      assert.ok(apiHits.length >= 2, `${service.id} missing real browser API requests`);
      for (const hit of apiHits) {
        assert.equal(hit.localAddress, service.ip); assert.equal(hit.localPort, apiPort);
        assert.equal(hit.host, 'localhost:' + apiPort); assert.equal(hit.origin, uiOrigin);
      }
    }
    console.log('PASS six concurrent Chrome/MCP sessions: two projects, four worktrees, two isolated main checkouts');
    console.log(`PASS route probes, UI ${uiOrigin}, API ${apiOrigin}, and cookie/storage isolation`);
  } catch (error) {
    process.exitCode = 1;
    checks.push({ status: 'failed', error: error.stack });
    console.error(error);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all(listeners.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    fs.writeFileSync(path.join(manifest.outputDir, 'result.json'), JSON.stringify({ time: new Date().toISOString(), checks, hits, serversClosed: listeners.every(s => !s.listening), mcpClosed: clients.every(c => c.closed()) }, null, 2));
  }
})();
