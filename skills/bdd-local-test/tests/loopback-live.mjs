// Each named Playwright CLI session uses its own localhost resolver configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openWorktreeCli } from '../scripts/lib/worktree-cli.mjs';
import { captureEvidence } from '../scripts/lib/evidence-screenshot.mjs';
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
async function allSessions(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

(async () => {
  try {
    // All six instances listen simultaneously on exactly the same two ports.
    await allSessions(manifest.services.flatMap(s => [listen(s, uiPort, false), listen(s, apiPort, true)]));
    const connected = await allSessions(manifest.services.map(async service => {
      const session = await openWorktreeCli(service.prepared);
      const client = { service, ...session };
      clients.push(client);
      fs.writeFileSync(path.join(manifest.outputDir, service.id, 'probe-evidence.json'), JSON.stringify(session.probe, null, 2));
      return client;
    }));
    await allSessions(connected.map(async client => {
      const { service } = client;
      const navigation = await client.run('goto', uiOrigin + '/');
      await client.run('run-code', `async page => {
        await page.getByText('"port":${apiPort}', { exact: false }).waitFor();
      }`);
      const evidence = await client.run('eval', `async () => {
        const api = await fetch('${apiOrigin}/api/recheck').then(r=>r.json());
        if (window.identity.ui !== ${JSON.stringify(service.id)} || api.id !== ${JSON.stringify(service.id)}) throw new Error('cross-routed identity');
        if (api.port !== ${apiPort} || api.ip !== ${JSON.stringify(service.ip)}) throw new Error('API IP/port changed');
        localStorage.setItem('instance', ${JSON.stringify(service.id)});
        document.cookie='instance=${service.id}; SameSite=Lax';
        return {url: location.href, identity: window.identity, api, userAgent: navigator.userAgent};
      }`);
      fs.writeFileSync(path.join(manifest.outputDir, service.id, 'navigation.json'), JSON.stringify(navigation, null, 2));
      fs.writeFileSync(path.join(manifest.outputDir, service.id, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
    }));
    // Recheck after every browser has written to the same localhost origin.
    await allSessions(connected.map(client => client.run('eval', `() => {
      if(localStorage.getItem('instance') !== ${JSON.stringify(client.service.id)} || !document.cookie.includes('instance=${client.service.id}')) throw new Error('browser storage leaked');
      return 'isolated';
    }`)));
    const sample = connected[0];
    const root = sample.service.prepared.preflight.root;
    const filename = '.bdd/live/evidence/masked.png';
    fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    fs.writeFileSync(path.join(root, '.bdd', 'config.json'), JSON.stringify({ mask: { selectors: ['#result'] } }));
    await captureEvidence(sample, root, { filename });
    const screenshot = fs.readFileSync(path.join(root, filename));
    assert.deepEqual(screenshot.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
    fs.writeFileSync(path.join(manifest.outputDir, sample.service.id, 'masked.png'), screenshot);
    for (const service of manifest.services) {
      const apiHits = hits.filter(h => h.id === service.id && h.api);
      assert.ok(apiHits.length >= 2, `${service.id} missing real browser API requests`);
      for (const hit of apiHits) {
        assert.equal(hit.localAddress, service.ip); assert.equal(hit.localPort, apiPort);
        assert.equal(hit.host, 'localhost:' + apiPort); assert.equal(hit.origin, uiOrigin);
      }
      checks.push({ id: service.id, ip: service.ip, uiPort, apiPort, isolationId: service.isolationId, status: 'passed' });
    }
    console.log('PASS six concurrent Playwright CLI sessions: two projects, four worktrees, two isolated main checkouts');
    console.log(`PASS route probes, UI ${uiOrigin}, API ${apiOrigin}, and cookie/storage isolation`);
  } catch (error) {
    process.exitCode = 1;
    checks.push({ status: 'failed', error: error.stack });
    console.error(error);
  } finally {
    const closed = await Promise.allSettled(clients.map(client => client.close()));
    for (const result of closed) {
      if (result.status === 'rejected') {
        process.exitCode = 1;
        checks.push({ status: 'failed', error: String(result.reason) });
        console.error(result.reason);
      }
    }
    await Promise.all(listeners.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    fs.writeFileSync(path.join(manifest.outputDir, 'result.json'), JSON.stringify({ time: new Date().toISOString(), checks, hits, serversClosed: listeners.every(s => !s.listening), sessionsClosed: clients.every(c => c.closed()) }, null, 2));
  }
})();
