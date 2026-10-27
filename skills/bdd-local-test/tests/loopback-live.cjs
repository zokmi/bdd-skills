// No browser automation dependency: all page operations go through independent
// stdio Playwright MCP servers, using the generated localhost resolver configs.
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const assert = require('node:assert/strict');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const listeners = [], clients = [], hits = [], checks = [];
function listen(service, port, api) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const hit = { id: service.id, api, url: req.url, host: req.headers.host,
        origin: req.headers.origin, localAddress: req.socket.localAddress, localPort: req.socket.localPort };
      hits.push(hit);
      res.setHeader('Cache-Control', 'no-store');
      if (api) {
        assert.equal(req.socket.localPort, 9453);
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4200');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: service.id, ip: req.socket.localAddress, port: req.socket.localPort }));
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><title>${service.id}</title><h1>${service.id}</h1><pre id="result">loading</pre>
          <script>fetch('http://localhost:9453/api/identity').then(r=>r.json()).then(api=>{
          window.identity={ui:${JSON.stringify(service.id)},api};
          document.querySelector('#result').textContent=JSON.stringify(window.identity);
          }).catch(e=>document.querySelector('#result').textContent=String(e));</script>`);
      }
    });
    server.on('error', reject);
    server.listen(port, service.ip, () => { listeners.push(server); resolve(); });
  });
}
function connect(service) {
  const child = spawn(process.execPath, [manifest.mcpCli, '--config', service.configPath], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let nextId = 0;
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let reply;
    try { reply = JSON.parse(line); } catch { return; }
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id); clearTimeout(item.timer);
    if (reply.error) item.reject(new Error(JSON.stringify(reply.error)));
    else item.resolve(reply.result);
  });
  const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${service.id} ${method} timed out: ${stderr}`)); }, 45000);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
  child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exited ${code}: ${stderr}`)); } pending.clear(); });
  const client = { service, child, rpc, async call(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(`${service.id} ${name}: ${JSON.stringify(result)}`);
    return result;
  }, async close() {
    try { await this.call('browser_close'); } catch {}
    child.stdin.end();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill();
    fs.writeFileSync(path.join(manifest.outputDir, service.id, 'mcp-stderr.log'), stderr);
  }};
  clients.push(client);
  return (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bdd-live-isolation-test', version: '1.0' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return client;
  })();
}
async function evaluate(client, fn) {
  const result = await client.call('browser_evaluate', { function: fn });
  const content = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { result, content };
}
(async () => {
  try {
    // All six instances listen simultaneously on exactly the same two ports.
    await Promise.all(manifest.services.flatMap(s => [listen(s, 4200, false), listen(s, 9453, true)]));
    const connected = await Promise.all(manifest.services.map(connect));
    await Promise.all(connected.map(async client => {
      const { service } = client;
      const navigation = await client.call('browser_navigate', { url: 'http://localhost:4200/' });
      await client.call('browser_wait_for', { text: '"port":9453' });
      const evidence = await evaluate(client, `async () => {
        const api = await fetch('http://localhost:9453/api/recheck').then(r=>r.json());
        if (window.identity.ui !== ${JSON.stringify(service.id)} || api.id !== ${JSON.stringify(service.id)}) throw new Error('cross-routed identity');
        if (api.port !== 9453 || api.ip !== ${JSON.stringify(service.ip)}) throw new Error('API IP/port changed');
        localStorage.setItem('instance', ${JSON.stringify(service.id)});
        document.cookie='instance=${service.id}; SameSite=Lax';
        return {url: location.href, identity: window.identity, api, userAgent: navigator.userAgent};
      }`);
      fs.writeFileSync(path.join(manifest.outputDir, service.id, 'navigation.json'), JSON.stringify(navigation, null, 2));
      fs.writeFileSync(path.join(manifest.outputDir, service.id, 'browser-evidence.json'), JSON.stringify(evidence.result, null, 2));
      checks.push({ id: service.id, ip: service.ip, uiPort: 4200, apiPort: 9453, isolationId: service.isolationId, status: 'passed' });
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
        assert.equal(hit.localAddress, service.ip); assert.equal(hit.localPort, 9453);
        assert.equal(hit.host, 'localhost:9453'); assert.equal(hit.origin, 'http://localhost:4200');
      }
    }
    console.log('PASS six concurrent Chrome/MCP sessions: two projects, four worktrees, two isolated main checkouts');
    console.log('PASS all UI localhost:4200 and API localhost:9453 route to their reserved IP/identity; cookies/storage isolated');
  } catch (error) {
    process.exitCode = 1;
    checks.push({ status: 'failed', error: error.stack });
    console.error(error);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all(listeners.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    fs.writeFileSync(path.join(manifest.outputDir, 'result.json'), JSON.stringify({ time: new Date().toISOString(), checks, hits, serversClosed: listeners.every(s => !s.listening), mcpClosed: clients.every(c => c.child.exitCode !== null || c.child.signalCode !== null) }, null, 2));
  }
})();
