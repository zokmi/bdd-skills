import { isCliEntry } from './lib/cli-entry.mjs';
import { buildCliSnippet } from './lib/routing.mjs';
import { loadKitConfig, readJson } from './lib/kit-config.mjs';

export function main([target, preparedFile, extra]) {
  if (!target || extra || (target === '--prepared') !== Boolean(preparedFile)) {
    throw new Error('Usage: node route-snippet.mjs <slot IP> | --prepared <preparation JSON>');
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
  console.log(buildCliSnippet(options));
}

export function runCli(args) {
  try {
    main(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

if (isCliEntry(import.meta)) {
  runCli(process.argv.slice(2));
}
