import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSlotIp, effectivePortMap } from './lib/routing.mjs';
import { assertRoleName, resolveApiUrl, extractToken, assertNoCredentials } from './lib/api-helpers.mjs';

function createApi({ ip, ports = {}, portMappings = [], login: profiles = {}, tokenDir, evidenceDir, timeoutMs = 30000 }) {
  assertSlotIp(ip);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error('Invalid API timeoutMs');
  }
  const effective = effectivePortMap(portMappings);
  const poolOptions = { keepAlive: true, maxFreeSockets: 2 };
  const httpAgent = new http.Agent(poolOptions);
  const httpsAgent = new https.Agent({ ...poolOptions, rejectUnauthorized: false });
  let cache;
  function cacheDir() {
    if (cache) return cache;
    const temp = fs.realpathSync(os.tmpdir());
    if (!tokenDir) return cache = fs.mkdtempSync(path.join(temp, 'bdd-api-'));
    const real = fs.realpathSync(tokenDir);
    const relative = path.relative(temp, real);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
        !fs.statSync(real).isDirectory()) {
      throw new Error('tokenDir must be a private subdirectory of the system temp directory');
    }
    return cache = real;
  }

  function tokenFile(role) {
    assertRoleName(role);
    if (role === 'none') throw new Error('Role none is reserved for anonymous calls');
    return path.join(cacheDir(), role + '.json');
  }

  function token(role) {
    if (role === undefined || role === null || role === 'none') return null;
    const file = tokenFile(role);
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('Expected a regular token file');
      return JSON.parse(fs.readFileSync(file, 'utf8')).token;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function saveToken(role, value) {
    if (typeof value !== 'string' || !/^[\x21-\x7E]+$/.test(value)) throw new Error('Invalid token');
    const file = tokenFile(role);
    const temporary = path.join(cacheDir(), randomUUID() + '.tmp');
    fs.writeFileSync(temporary, JSON.stringify({ token: value }), { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async function call(role, method, address, body, extraHeaders = {}) {
    const target = resolveApiUrl(address, ip, ports, effective);
    const auth = token(role);
    const headers = { ...extraHeaders };
    for (const name of Object.keys(headers)) {
      if (auth && name.toLowerCase() === 'authorization') delete headers[name];
    }
    if (auth) headers.Authorization = 'Bearer ' + auth;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const start = Date.now();
    const secure = target.protocol === 'https:';
    const reqFn = secure ? https.request : http.request;
    const { status, raw } = await new Promise((resolve, reject) => {
      const request = reqFn(target, { method, headers, agent: secure ? httpsAgent : httpAgent }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve({
          status: response.statusCode, raw: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      const timer = setTimeout(() => request.destroy(new Error('API request timed out after ' + timeoutMs + 'ms')), timeoutMs);
      timer.unref();
      request.once('close', () => clearTimeout(timer));
      request.on('error', reject);
      request.end(payload);
    });
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    return { status, ms: Date.now() - start, body: parsed, raw };
  }

  async function login(role, profile, credentials = {}) {
    const file = tokenFile(role);
    if (!Object.hasOwn(profiles, profile)) throw new Error('Unknown login profile');
    const { endpoint, fields, env = {}, tokenPath } = profiles[profile];
    const payload = Object.fromEntries(Object.entries(fields).map(([name, key]) => {
      const value = credentials[key] ?? (Object.hasOwn(env, key) ? process.env[env[key]] : undefined);
      if (typeof value !== 'string' || !value) throw new Error('Missing credential input: ' + key);
      return [name, value];
    }));
    fs.rmSync(file, { force: true });
    const result = await call('none', 'POST', endpoint, payload);
    const value = result.status >= 200 && result.status < 300 && extractToken(result.body, tokenPath);
    if (value) saveToken(role, value);
    return { status: result.status, ok: Boolean(value) };
  }

  function saveEvidence(file, value) {
    if (!evidenceDir) throw new Error('Missing evidenceDir');
    if (typeof file !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(file)) {
      throw new Error('Evidence filename must be a single safe basename');
    }
    const text = assertNoCredentials(value);
    fs.mkdirSync(evidenceDir, { recursive: true });
    const output = path.resolve(evidenceDir, file);
    fs.writeFileSync(output, text, { flag: 'wx' });
    return output;
  }

  function closeConnections() {
    httpAgent.destroy();
    httpsAgent.destroy();
  }

  return { call, token, saveToken, login, saveEvidence, closeConnections, get tokenDir() { return cacheDir(); } };
}

export { createApi };
