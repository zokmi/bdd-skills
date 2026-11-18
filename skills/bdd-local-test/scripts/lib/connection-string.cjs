'use strict';

function parseConnectionString(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty connection string');
  const values = Object.create(null);
  const pair = /\s*([^=;\s][^=;]*?)\s*=\s*(?:"((?:""|[^"])*)"|'((?:''|[^'])*)'|([^"';][^;]*?)|)\s*(?:;|$)/y;
  let index = 0;
  while (index < text.length) {
    if (/[\s;]/.test(text[index])) {
      index++;
      continue;
    }
    pair.lastIndex = index;
    const match = pair.exec(text);
    if (!match) throw new Error('Invalid connection string segment or quoted value');
    const [, key, double, single, unquoted] = match;
    const normalized = key.trim().toLowerCase();
    delete values[normalized]; // Keep last-write order across aliases.
    values[normalized] = double?.replace(/""/g, '"') ?? single?.replace(/''/g, "'") ?? unquoted ?? '';
    index = pair.lastIndex;
  }
  return { ...values };
}

function parseSetting(value, name, choices, fallback) {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!Object.hasOwn(choices, normalized)) throw new Error('Invalid ' + name + ' setting');
  return choices[normalized];
}

function toMssqlConfig(text, { requestTimeout = 120000 } = {}) {
  const values = parseConnectionString(text);
  const bool = { true: true, yes: true, false: false, no: false };
  // Preserve last occurrence even when it uses an alias.
  function last(...keys) {
    const key = Object.keys(values).reverse().find((key) => keys.includes(key));
    return key === undefined ? undefined : values[key];
  }
  const windows = last('integrated security', 'integratedsecurity', 'trusted_connection', 'trusted connection');
  if (parseSetting(windows, 'Integrated Security', { ...bool, sspi: true }, false)) {
    throw new Error('Windows integrated authentication is unsupported. Supply a SQL authentication connection string');
  }
  const server = last('server', 'data source', 'address', 'addr', 'network address')?.replace(/^tcp:/i, '');
  if (!server) throw new Error('Missing Server or Data Source');
  const match = /^([^\\,]+)(?:\\([^\\,]+)|,\s*(\d+))?$/.exec(server);
  if (!match || !match[1].trim() || (match[2] && !match[2].trim())) throw new Error('Invalid SQL Server host, instance or port');
  const [, host, instanceName, portText] = match;
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error('Invalid SQL Server port');
  const database = last('database', 'initial catalog');
  if (!database) throw new Error('Missing Database or Initial Catalog');
  const user = last('user id', 'uid', 'user');
  if (!user) throw new Error('Missing User Id');
  const encrypt = parseSetting(last('encrypt'), 'Encrypt', { ...bool, mandatory: true, strict: 'strict', optional: false }, true);
  const trust = parseSetting(last('trustservercertificate', 'trust server certificate'), 'TrustServerCertificate', bool, false);
  const config = {
    server: host.trim(), database, user, password: last('password', 'pwd'), requestTimeout,
    options: { encrypt, trustServerCertificate: encrypt === 'strict' ? false : trust },
  };
  if (instanceName) config.options.instanceName = instanceName.trim();
  if (port !== undefined) config.port = port;
  const timeout = last('connect timeout', 'connection timeout', 'timeout');
  if (timeout !== undefined) {
    if (!/^\d+$/.test(timeout) || Number(timeout) > 2147483) throw new Error('Invalid Connect Timeout');
    config.connectionTimeout = Number(timeout) * 1000;
  }
  return config;
}

module.exports = { parseConnectionString, toMssqlConfig };
