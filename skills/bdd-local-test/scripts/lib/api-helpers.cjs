'use strict';

const { assertSlotIp, assertPort } = require('./routing.cjs');

function assertRoleName(role) {
  if (typeof role !== 'string' || !role || /[^A-Za-z0-9_-]/.test(role) || role.length > 64 ||
      /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(role)) {
    throw new Error('Invalid role name');
  }
  return role;
}

function resolveApiUrl(address, ip, ports, effective = new Map()) {
  assertSlotIp(ip);
  const alias = /^([A-Za-z][A-Za-z0-9_-]*):(\/(?!\/).*)$/.exec(address);
  let url;
  if (alias) {
    if (!Object.hasOwn(ports, alias[1])) throw new Error('Unknown API prefix');
    const service = ports[alias[1]];
    const protocol = typeof service === 'number' ? 'https' : service.protocol ?? 'https';
    if (!['http', 'https'].includes(protocol)) throw new Error('Invalid API protocol');
    const port = assertPort(typeof service === 'number' ? service : service.port);
    url = new URL(protocol + '://' + ip + ':' + (effective.get(port) ?? port) + alias[2]);
  } else {
    url = new URL(address);
  }
  if (url.hostname !== ip || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.hash) {
    throw new Error('API target must be an HTTP(S) URL on the assigned slot IP');
  }
  return url;
}

function extractToken(body, tokenPath) {
  if (!Array.isArray(tokenPath) || !tokenPath.length ||
      tokenPath.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('Expected a nonempty tokenPath array');
  }
  const result = tokenPath.reduce((value, key) =>
    value != null && Object.hasOwn(value, key) ? value[key] : undefined, body);
  return typeof result === 'string' && /^[\x21-\x7E]+$/.test(result) ? result : null;
}

const secretKey = /(?:token|password|passwd|secret|api[_ -]?key|otp(?:[_ -]?code)?|authorization|cookie)$|^pwd$/i;
const jwt = /\beyJ[\w-]*\.[\w-]+(?:\.[\w-]*)?\b/;
const bearer = /\bBearer(?:[\s"'=:+]|%[02][09ad]|\\[tnr])+\S/i;
const textField = /["']?([\w-]+)["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;}&#]+))/g;

function assertNoCredentials(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined) throw new Error('Expected serializable evidence');
  function reject() { throw new Error('Evidence contains credentials'); }
  function inspectString(str, scanFields = true) {
    if (jwt.test(str) || bearer.test(str)) reject();
    if (!scanFields) return;
    for (const [, key, double, single, unquoted] of str.matchAll(textField)) {
      const field = double ?? single ?? unquoted;
      if (secretKey.test(key) && field && (double !== undefined || single !== undefined || field !== 'null')) reject();
    }
  }
  function inspect(item) {
    if (typeof item === 'string') return inspectString(item);
    if (item === null || typeof item !== 'object') return;
    for (const [key, field] of Object.entries(item)) {
      inspectString(key, false);
      if (secretKey.test(key) && field !== null && field !== '') reject();
      inspect(field);
    }
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* Plain text evidence. */ }
  if (typeof value === 'string' && typeof parsed !== 'object') inspectString(text);
  inspect(parsed);
  return text;
}

module.exports = { assertRoleName, resolveApiUrl, extractToken, assertNoCredentials };
