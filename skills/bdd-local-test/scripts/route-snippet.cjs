'use strict';

const { buildMcpSnippet } = require('./lib/routing.cjs');
const { loadKitConfig, readJson } = require('./lib/kit-config.cjs');

const [target, preparedFile, extra] = process.argv.slice(2);
try {
  if (!target || extra || (target === '--prepared') !== Boolean(preparedFile)) {
    throw new Error('Usage: node route-snippet.cjs <slot IP> | --prepared <preparation JSON>');
  }
  const prepared = preparedFile ? readJson(preparedFile) : undefined;
  if (prepared && prepared.preflight?.isolated !== true) throw new Error('Expected an isolated preflight');
  const { routing } = loadKitConfig();
  if (!routing) throw new Error('Missing kit.routing in .bdd/config.json');
  const options = {
    frontendPorts: routing.frontendPorts,
    apiPorts: routing.apiPorts,
    ip: prepared ? prepared.preflight.ip : target,
    portMappings: prepared?.portMappings,
  };
  console.log(buildMcpSnippet(options));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
