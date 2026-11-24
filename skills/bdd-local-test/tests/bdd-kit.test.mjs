import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSlotIp, assertPort, routeOptions, routeLocalhostToSlot, buildMcpSnippet } from '../scripts/lib/routing.mjs';
import { assertRoleName, resolveApiUrl, extractToken, assertNoCredentials } from '../scripts/lib/api-helpers.mjs';
import { parseConnectionString, toMssqlConfig } from '../scripts/lib/connection-string.mjs';
import { createApi } from '../scripts/api.mjs';
import { createDb, resolveConnectionString } from '../scripts/db.mjs';

const scripts = fileURLToPath(new URL('../scripts', import.meta.url));

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-kit-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('installed kit runs from a standalone scripts directory', async t => {
  const root = temp(t);
  const installed = path.join(root, 'skill #1', 'scripts');
  fs.cpSync(scripts, installed, { recursive: true });
  fs.mkdirSync(path.join(root, '.bdd'));
  fs.writeFileSync(path.join(root, '.bdd', 'config.json'), '{"kit":{"database":{"enabled":false}}}');

  const load = name => import(pathToFileURL(path.join(installed, name)).href);
  const config = await load('lib/kit-config.mjs');
  const api = await load('api.mjs');
  const db = await load('db.mjs');
  const kit = config.loadKitConfig(root);
  assert.deepEqual(kit.database, { enabled: false });
  assert.equal(api.createApi({ ip: '127.0.0.2' }).token('none'), null);
  await assert.rejects(db.createDb(kit.database, { root }).query('SELECT 1'), /disabled/);

  if (process.features.require_module) {
    const requireInstalled = createRequire(path.join(installed, 'consumer.cjs'));
    fs.writeFileSync(path.join(installed, 'consumer.mjs'), `
      import { createApi } from './api.cjs';
      import { createDb, resolveConnectionString } from './db.cjs';
      import { loadKitConfig, readJson } from './lib/kit-config.cjs';
      import { assertSlotIp, assertPort, effectivePortMap, routeOptions, routeLocalhostToSlot, buildMcpSnippet } from './lib/routing.cjs';
      export { createApi, createDb, resolveConnectionString, loadKitConfig, readJson,
        assertSlotIp, assertPort, effectivePortMap, routeOptions, routeLocalhostToSlot, buildMcpSnippet };
    `);
    const imported = await load('consumer.mjs');
    const routing = await load('lib/routing.mjs');
    for (const [entry, esm] of Object.entries({ api, db, 'lib/kit-config': config, 'lib/routing': routing })) {
      const required = requireInstalled('./' + entry + '.cjs');
      for (const [name, fn] of Object.entries(esm)) {
        assert.equal(imported[name], fn, name);
        assert.equal(required[name], fn, name);
      }
    }
  }
});

test('validates both slot IP and port boundaries', () => {
  for (const ip of ['127.0.0.2', '127.0.0.254']) assert.equal(assertSlotIp(ip), ip);
  for (const ip of [null, 'localhost', '127.0.0.1', '127.0.0.255', '127.0.0.002', '127.0.0.2\n', '127.0.1.2']) {
    assert.throws(() => assertSlotIp(ip), /Slot IP/);
  }
  for (const port of [1, 65535]) assert.equal(assertPort(port), port);
  for (const port of [0, 65536, -1, 1.5, '81', NaN]) assert.throws(() => assertPort(port), /Port/);
});

test('route options reject invalid arrays and overlapping port mappings', () => {
  const ip = '127.0.0.2';
  assert.deepEqual(routeOptions({ ip }).routes, {});
  assert.throws(() => routeOptions({ ip, apiPorts: '81' }), /port array/);
  assert.throws(() => routeOptions({ ip, apiPorts: [81], frontendPorts: [81] }), /Conflicting/);
  const mapping = { originalPort: 81, effectivePort: 82 };
  assert.throws(() => routeOptions({ ip, portMappings: [mapping, mapping] }), /Duplicate/);
  assert.deepEqual(routeOptions({ ip, apiPorts: [81], portMappings: [mapping] }).routes, {
    81: { kind: 'api', target: 82 }, 82: { kind: 'api', target: 82 },
  });
});

function routeFixture() {
  const events = [];
  const mock = { match: (url) => url.hostname === 'mock.invalid', handler: () => {} };
  const installed = [mock];
  const context = {
    async route(match, handler) { installed.push({ match, handler }); },
    async unroute(match, handler) {
      const index = installed.findIndex((entry) => entry.match === match && entry.handler === handler);
      assert.ok(index > 0);
      installed.splice(index, 1);
    },
    request: {
      async fetch(url, options) {
        events.push(['fetch', url, { ...options, headers: { ...options.headers } }]);
        return { dispose: async () => events.push(['dispose']) };
      },
    },
  };
  async function visit(address) {
    const entry = installed.findLast(({ match }) => match(new URL(address)));
    if (!entry) return;
    await entry.handler({
      request: () => ({
        url: () => address, headers: () => ({ Host: 'localhost', Origin: 'http://localhost:81' }),
        method: () => 'POST', postDataBuffer: () => Buffer.from('payload'),
      }),
      continue: async ({ url }) => events.push(['continue', url]),
      fulfill: async ({ response }) => events.push(['fulfill', Boolean(response)]),
      abort: async () => events.push(['abort']),
    });
  }
  return { events, mock, installed, context, visit };
}

const routeSettings = {
  ip: '127.0.0.3', frontendPorts: [80, 81], apiPorts: [82],
  portMappings: [{ originalPort: 82, effectivePort: 83 }],
};

test('Node and VM MCP snippet route requests identically and preserve existing mocks', async () => {
  const node = routeFixture();
  const mcp = routeFixture();
  const installMcp = (fixture, options) => vm.runInNewContext(buildMcpSnippet(options), { URL })({
    context: () => fixture.context,
  });
  for (const [fixture, install] of [[node, routeLocalhostToSlot.bind(null, node.context)], [mcp, installMcp.bind(null, mcp)]]) {
    await install(routeSettings);
    await fixture.visit('http://localhost/view?next=//localhost:81');
    await fixture.visit('https://localhost:82/call');
    await fixture.visit('http://localhost:83/call');
    await fixture.visit('http://localhost:821/');
    await fixture.visit('ws://localhost:81/');
    await fixture.visit('http://remote.invalid:81/');
    const slotHandler = fixture.installed[1];
    const mock84 = (url) => url.port === '84' && url.pathname === '/mock';
    const mockHandler = () => fixture.events.push(['mock', true]);
    await fixture.context.route(mock84, mockHandler);
    await install({ ip: '127.0.0.254', frontendPorts: [84] });
    assert.equal(fixture.installed.length, 3);
    assert.equal(fixture.installed[1], slotHandler);
    await fixture.visit('http://localhost:84/mock');
    assert.equal(fixture.installed[0], fixture.mock);
    await fixture.visit('http://localhost:81/');
    await fixture.visit('http://localhost:84/');
    await install({ ip: '127.0.0.2' });
    assert.deepEqual(fixture.installed, [fixture.mock, { match: mock84, handler: mockHandler }]);
  }
  assert.deepEqual(node.events, mcp.events);
  assert.deepEqual(node.events.map(([operation, address]) => [operation, address]), [
    ['continue', 'http://127.0.0.3/view?next=//localhost:81'],
    ['fetch', 'https://127.0.0.3:83/call'], ['fulfill', true], ['dispose', undefined],
    ['fetch', 'http://127.0.0.3:83/call'], ['fulfill', true], ['dispose', undefined],
    ['mock', true], ['continue', 'http://127.0.0.254:84/'],
  ]);
  assert.equal(node.events[1][2].ignoreHTTPSErrors, true);
  assert.equal(node.events[1][2].maxRedirects, 0);
  assert.equal(node.events[1][2].headers.Host, undefined);
  assert.equal(node.events[1][2].data.toString(), 'payload');
  assert.equal(node.events[4][2].ignoreHTTPSErrors, false);
});

test('concurrent installs serialize and a failed API fetch aborts the route', async () => {
  const fixture = routeFixture();
  await Promise.all([
    routeLocalhostToSlot(fixture.context, { ip: '127.0.0.2', frontendPorts: [81] }),
    routeLocalhostToSlot(fixture.context, { ip: '127.0.0.3', apiPorts: [82] }),
  ]);
  assert.equal(fixture.installed.length, 2);
  fixture.context.request.fetch = async () => { throw new Error('network failure'); };
  await assert.rejects(fixture.visit('https://localhost:82/'), /network failure/);
  assert.deepEqual(fixture.events, [['abort']]);
});

test('CLI reads BOM config and isolated preflight port mappings', async (t) => {
  const cwd = temp(t);
  fs.mkdirSync(path.join(cwd, '.bdd'));
  fs.writeFileSync(path.join(cwd, '.bdd/config.json'), '\uFEFF' + JSON.stringify({
    kit: { routing: { frontendPorts: [81], apiPorts: [82] } },
  }));
  const run = (...args) => spawnSync(process.execPath, [path.join(scripts, 'route-snippet.mjs'), ...args],
    { cwd, encoding: 'utf8' });
  const result = run('127.0.0.3');
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(cwd, 'prepare.json');
  fs.writeFileSync(file, JSON.stringify({
    preflight: { isolated: true, ip: routeSettings.ip }, portMappings: routeSettings.portMappings,
  }));
  const prepared = run('--prepared', file);
  assert.equal(prepared.status, 0, prepared.stderr);
  const fixture = routeFixture();
  await vm.runInNewContext(prepared.stdout, { URL })({ context: () => fixture.context });
  await fixture.visit('https://localhost:82/');
  assert.equal(fixture.events[0][1], 'https://127.0.0.3:83/');
  assert.equal(run('127.0.0.1').status, 2);
  assert.equal(run('--prepared').status, 2);
  fs.writeFileSync(file, '{}');
  assert.equal(run('--prepared', file).status, 2);
});

test('API names, address, protocol and token path validation', () => {
  assert.equal(assertRoleName('Role_2-dev'), 'Role_2-dev');
  for (const role of ['', '..', '../test', 'a\\b', 'a\n', 'CON', 12, 'x'.repeat(65)]) {
    assert.throws(() => assertRoleName(role), /role/);
  }
  const ip = '127.0.0.2';
  const ports = { v2: 8443, plain: { port: 8080, protocol: 'http' }, bad: { port: 80, protocol: 'ftp' } };
  assert.equal(resolveApiUrl('v2:/ready', ip, ports).href, 'https://127.0.0.2:8443/ready');
  assert.equal(resolveApiUrl('plain:/ready', ip, ports).href, 'http://127.0.0.2:8080/ready');
  for (const address of ['https://127.0.0.3/', 'http://localhost/', 'v3:/a', 'constructor:/a',
    'http://u:p@127.0.0.2/', 'ftp://127.0.0.2/', 'bad:/a']) {
    assert.throws(() => resolveApiUrl(address, ip, ports));
  }
  for (const timeoutMs of [0, -1, 1.5, 2147483648, '20']) {
    assert.throws(() => createApi({ ip, timeoutMs }), /timeout/);
  }
  assert.equal(extractToken({ data: [{ key: 'abc' }] }, ['data', '0', 'key']), 'abc');
  assert.equal(extractToken({ data: null }, ['data', 'key']), null);
  assert.equal(extractToken({}, ['constructor']), null);
  assert.throws(() => extractToken({}, []), /tokenPath/);
});

test('evidence inspects serialized and nested content before writing', (t) => {
  const dir = temp(t);
  const api = createApi({ ip: '127.0.0.2', evidenceDir: dir });
  const unsafe = [
    'eyJaa.bb.cc', 'Bearer x', 'bEaReR\tX!', 'Bearer%20abc', 'bearer+x', 'Authorization: Bearer: x',
    { data: [{ accessToken: 'x' }] }, '{"pass\\u0077ord":"x"}', '{"otp":0}',
    { password: false }, { secret: ' ' }, { api_key: 'x' }, 'password="quote"', 'otp=0',
    { nested: 'token=opaque' }, { ['Bearer x']: 'value' },
  ];
  for (const input of unsafe) assert.throws(() => api.saveEvidence('result.json', input), /credentials/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const safe = { status: 200, password: '', otp: null, hasPasswordReset: true, count: 0 };
  assert.equal(assertNoCredentials('request passed'), 'request passed');
  assert.equal(assertNoCredentials('null'), 'null');
  assert.deepEqual(JSON.parse(fs.readFileSync(api.saveEvidence('result.json', safe))), safe);
  assert.throws(() => api.saveEvidence('../other.json', safe), /basename/);
  assert.throws(() => api.saveEvidence('result.json', safe), /EEXIST/);
});

function mockHttp(t, handler) {
  return t.mock.method(http, 'request', (url, options, callback) => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    response.statusCode = 200;
    request.end = (body) => {
      callback(response);
      handler(url, options, body, response);
    };
    request.destroy = (error) => {
      request.emit('error', error);
      response.emit('close');
      request.emit('close');
    };
    response.once('end', () => request.emit('close'));
    return request;
  });
}

test('login uses mapped explicit/env inputs, stores only in temp, and API never follows redirects', async (t) => {
  const env = 'BDD_FIXTURE_PASSWORD';
  const beforeTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const transport = mockHttp(t, (url, options, body, response) => {
    let result;
    if (url.pathname === '/login') {
      const input = JSON.parse(body);
      result = { session: { value: input.account === 'sample' && input.pass === 'fixture-placeholder' ? 'opaque' : null } };
    } else {
      response.statusCode = 302;
      response.headers = { location: 'http://example.invalid/' };
      result = { accepted: options.headers.Authorization === 'Bearer opaque' };
    }
    response.emit('data', Buffer.from(JSON.stringify(result)));
    response.emit('end');
  });
  process.env[env] = 'fixture-placeholder';
  t.after(() => { delete process.env[env]; });
  const dir = temp(t);
  const api = createApi({
    ip: '127.0.0.2', tokenDir: dir, ports: { test: { port: 8080, protocol: 'http' } },
    portMappings: [{ originalPort: 8080, effectivePort: 8081 }],
    login: { primary: {
      endpoint: 'test:/login', fields: { account: 'name', pass: 'password' },
      env: { password: env }, tokenPath: ['session', 'value'],
    } },
  });
  assert.deepEqual(await api.login('reader', 'primary', { name: 'sample' }), { status: 200, ok: true });
  assert.equal(api.token('reader'), 'opaque');
  const result = await api.call('reader', 'GET', 'test:/redirect', undefined, { authorization: 'override' });
  assert.equal(result.status, 302);
  assert.equal(transport.mock.callCount(), 2);
  assert.equal(transport.mock.calls[1].arguments[0].href, 'http://127.0.0.2:8081/redirect');
  await api.call('reader', 'GET', 'http://127.0.0.2:8080/direct');
  assert.equal(transport.mock.calls[2].arguments[0].port, '8080');
  assert.deepEqual(result.body, { accepted: true });
  assert.deepEqual(await api.login('reader', 'primary', { name: 'bad' }), { status: 200, ok: false });
  assert.equal(api.token('reader'), null);
  await assert.rejects(api.login('../reader', 'primary'), /role/);
  await assert.rejects(api.login('reader', 'primary'), /Missing credential input/);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, beforeTls);
});

test('timeout is a total deadline even if HTTP response keeps producing data', async (t) => {
  mockHttp(t, (_url, _options, _body, response) => {
    const timer = setInterval(() => response.emit('data', Buffer.from('partial')), 10);
    response.once('close', () => clearInterval(timer));
    t.after(() => clearInterval(timer));
  });
  const api = createApi({ ip: '127.0.0.2', timeoutMs: 120 });
  await assert.rejects(api.call('none', 'GET', 'http://127.0.0.2:8080/'), /timed out after 120ms/);
});

test('API reuses the slot connection per client and can release it before a service restart', async t => {
  const ip = '127.0.0.4';
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    sockets.add(request.socket);
    response.end(request.url);
  });
  const api = createApi({ ip });
  const other = createApi({ ip });
  server.listen(0, ip);
  t.after(() => {
    api.closeConnections?.();
    other.closeConnections?.();
    server.close();
    server.closeAllConnections();
  });
  await once(server, 'listening');
  const url = 'http://' + ip + ':' + server.address().port;
  for (const route of ['/first', '/second', '/third']) {
    assert.equal((await api.call('none', 'GET', url + route)).body, route);
  }
  assert.equal(sockets.size, 1);
  await other.call('none', 'GET', url + '/other');
  assert.equal(sockets.size, 2);
  api.closeConnections();
  await api.call('none', 'GET', url + '/after-close');
  assert.equal(sockets.size, 3);
});

test('ADO.NET parsing supports quoting, delimiters, aliases, instance, port and timeout', () => {
  assert.deepEqual(parseConnectionString(` ; USER ID=x=y;Password="a;""b"""; Other='it''s'; Empty= ;`),
    { 'user id': 'x=y', password: 'a;"b"', other: "it's", empty: '' });
  for (const invalid of ['', 'Server', 'X="a', 'X="a"suffix', 'X;Y=1']) {
    assert.throws(() => parseConnectionString(invalid), /connection string/);
  }
  const base = ';Initial Catalog=dev;UID=fixture;pwd="a;b"';
  assert.deepEqual(toMssqlConfig('Server=host\\instance' + base + ';Connect Timeout=0').options,
    { instanceName: 'instance', encrypt: true, trustServerCertificate: false });
  assert.equal(toMssqlConfig('Server=host' + base + ';Timeout=0').connectionTimeout, 0);
  const conf = toMssqlConfig('Data Source=tcp:host,65535' + base + ';connection timeout=8', { requestTimeout: 50 });
  assert.equal(conf.server, 'host');
  assert.equal(conf.port, 65535);
  assert.equal(conf.connectionTimeout, 8000);
  assert.equal(conf.requestTimeout, 50);
  for (const bad of ['host,0', 'host,65536', 'host,1.5', 'host\\a,10', ',100']) {
    assert.throws(() => toMssqlConfig('Server=' + bad + base), /host|port/);
  }
  assert.throws(() => toMssqlConfig('Integrated Security=SSPI;Server=host' + base), /Windows integrated/);
  assert.throws(() => toMssqlConfig('Server=host' + base + ';Connect Timeout=-1'), /Connect Timeout/);
});

test('encrypt and certificate settings preserve Strict semantics', () => {
  const base = 'Server=host;Database=dev;User Id=fixture;';
  for (const [value, expected] of Object.entries({ True: true, Mandatory: true, Strict: 'strict',
    Optional: false, False: false, No: false, YES: true })) {
    const { options } = toMssqlConfig(base + 'Encrypt=' + value + ';TrustServerCertificate=True');
    assert.equal(options.encrypt, expected);
    assert.equal(options.trustServerCertificate, expected !== 'strict');
  }
  assert.equal(toMssqlConfig(base + 'Trust Server Certificate=No').options.trustServerCertificate, false);
  assert.throws(() => toMssqlConfig(base + 'Encrypt=lax'), /Encrypt/);
  assert.throws(() => toMssqlConfig(base + 'TrustServerCertificate=lax'), /TrustServerCertificate/);
});

test('DB config honors environment priority, ordered overlays, disabled and missing settings', (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'base.json'), JSON.stringify({ ConnectionStrings: { Test: 'base' } }));
  fs.writeFileSync(path.join(root, 'overlay.json'), JSON.stringify({ ConnectionStrings: { Test: 'overlay' } }));
  const settings = { enabled: true, connectionEnv: 'TEST_DB', connectionName: 'Test',
    appsettings: ['base.json', 'missing.json', 'overlay.json'] };
  assert.equal(resolveConnectionString(settings, root, {}), 'overlay');
  assert.equal(resolveConnectionString(settings, root, { TEST_DB: 'env' }), 'env');
  assert.throws(() => resolveConnectionString({ ...settings, enabled: false }, root), /disabled/);
  assert.throws(() => resolveConnectionString({ ...settings, connectionName: 'Missing' }, root, {}), /missing/);
  fs.writeFileSync(path.join(root, 'overlay.json'), '{invalid');
  assert.throws(() => resolveConnectionString(settings, root, {}), /Invalid JSON/);
});

test('only the HTTPS transport receives the private certificate exception', async (t) => {
  const request = t.mock.method(https, 'request', (url, { agent }, callback) => {
    assert.equal(url.hostname, '127.0.0.254');
    assert.equal(agent.options.rejectUnauthorized, false);
    assert.equal(agent.keepAlive, true);
    assert.notEqual(agent, https.globalAgent);
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 204;
      callback(res);
      res.emit('end');
      req.emit('close');
    };
    return req;
  });
  const api = createApi({ ip: '127.0.0.254', ports: { api: 8490 } });
  await assert.rejects(api.call('none', 'GET', 'https://127.0.0.2/'), /slot IP/);
  assert.equal((await api.call('none', 'GET', 'api:/ready')).status, 204);
  assert.equal(request.mock.callCount(), 1);
});

test('DB shares one pool in a scope, waits for pending queries, and reconnects after failure', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
    ConnectionStrings: { DefaultConnection: 'Server=fixture;Database=fixture;UID=fixture' },
  }));
  const driver = path.join(root, 'node_modules', 'mssql');
  fs.mkdirSync(driver, { recursive: true });
  fs.writeFileSync(path.join(driver, 'package.json'), '{"exports":"./index.mjs"}');
  fs.writeFileSync(path.join(driver, 'index.mjs'), `
    import { setTimeout as delay } from 'node:timers/promises';
    export const state = { events: [], offline: false };
    const { events } = state;
    export class ConnectionPool {
      async connect() { events.push('connect'); if (state.offline) throw Error('offline'); }
      async close() { events.push('close'); }
      request() {
        return {
          input(name, value) { events.push([name, value]); },
          async query(text) { await delay(5); events.push(text); return { recordset: [text] }; },
          async batch(text) { return { recordsets: [[text], []] }; },
        };
      }
    }
  `);
  const { state: sql } = await import(pathToFileURL(path.join(driver, 'index.mjs')).href);
  const db = createDb({ enabled: true, appsettings: ['settings.json'] }, { root });
  let scoped;
  assert.deepEqual(await db.withSession(async session => {
    scoped = session;
    return Promise.all([session.query('SELECT @id', { id: 7 }), session.run('SELECT 2')]);
  }), [['SELECT @id'], [['SELECT 2'], []]]);
  assert.deepEqual(sql.events.splice(0), ['connect', ['id', 7], 'SELECT @id', 'close']);
  await assert.rejects(scoped.query('SELECT 3'), /session is closed/);
  await assert.rejects(db.withSession(session => {
    session.query('SELECT 4');
    throw Error('verification failed');
  }), /verification failed/);
  assert.deepEqual(sql.events.splice(0), ['connect', 'SELECT 4', 'close']);
  sql.offline = true;
  await assert.rejects(db.withSession(() => assert.fail('connected while offline')), /offline/);
  sql.offline = false;
  assert.deepEqual(await db.withSession(session => session.query('SELECT 5')), ['SELECT 5']);
  assert.deepEqual(sql.events, ['connect', 'close', 'connect', 'SELECT 5', 'close']);
});

test('DB lazily loads project driver, binds values and closes after all lock outcomes', async (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
    ConnectionStrings: { DefaultConnection: 'Server=fixture;Database=fixture;UID=fixture' },
  }));
  const driver = path.join(root, 'node_modules', 'mssql');
  const db = createDb({ enabled: true, appsettings: ['settings.json'] }, { root });
  await assert.rejects(createDb({}, { root }).query('SELECT 1'), /disabled/);
  await assert.rejects(db.query('SELECT 1'), /Install mssql/);
  fs.mkdirSync(driver, { recursive: true });
  fs.writeFileSync(path.join(driver, 'index.js'), [
    'const events = exports.events = [];',
    'exports.lockStatus = 0;',
    'exports.ConnectionPool = class {',
    '  async connect() { events.push("connect"); if (exports.failConnect) throw Error("offline"); }',
    '  async close() { events.push("close"); }',
    '  request() { return new exports.Request(); }',
    '};',
    'exports.Transaction = class {',
    '  async begin() { events.push("begin"); if (exports.failBegin) throw Error("begin failed"); }',
    '  async rollback() { events.push("rollback"); }',
    '};',
    'exports.Request = class {',
    '  input(name, value) { events.push([name, value]); return this; }',
    '  async batch(text) { return { recordsets: [[text], []] }; }',
    '  async query(text) {',
    '    if (exports.failQuery) throw Error("query failed");',
    '    return { recordset: text.includes("sp_getapplock") ? [{ r: exports.lockStatus }] : [{ text }] };',
    '  }',
    '};',
  ].join('\n'));
  const { default: sql } = await import(pathToFileURL(path.join(driver, 'index.js')).href);
  assert.deepEqual(await db.run('batch'), [['batch'], []]);
  assert.deepEqual(await db.query('SELECT @id', { id: 'sample' }), [{ text: 'SELECT @id' }]);
  assert.deepEqual(sql.events.splice(0), ['connect', 'close', 'connect', ['id', 'sample'], 'close']);
  const lock = await db.holdAppLock('fixture', 20000);
  assert.equal(lock.held, true);
  await Promise.all([lock.release(), lock.release()]);
  const lockEvents = ['connect', 'begin', ['res', 'fixture'], 'rollback', 'close'];
  assert.deepEqual(sql.events.splice(0), lockEvents);
  sql.lockStatus = -1;
  assert.equal((await db.holdAppLock('fixture', 20000)).held, false);
  assert.deepEqual(sql.events.splice(0), lockEvents);
  sql.failBegin = true;
  await assert.rejects(db.holdAppLock('fixture', 20000), /begin failed/);
  assert.deepEqual(sql.events.splice(0), ['connect', 'begin', 'rollback', 'close']);
  sql.failBegin = false;
  sql.failQuery = true;
  await assert.rejects(db.holdAppLock('fixture', 20000), /query failed/);
  assert.deepEqual(sql.events.splice(0), lockEvents);
  sql.failConnect = true;
  await assert.rejects(db.query('SELECT 1'), /offline/);
  assert.deepEqual(sql.events.splice(0), ['connect', 'close']);
});
