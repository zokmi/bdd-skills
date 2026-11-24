import { isCliEntry } from './lib/cli-entry.mjs';
import { openWorktreeCli } from './lib/worktree-cli.mjs';
import { readManifest } from './probe-cli-route.mjs';

export async function main([manifestPath, flag, cliPath, ...extra]) {
  if (!manifestPath || extra.length || (flag && (flag !== '--cli-path' || !cliPath))) {
    throw new Error('Usage: node worktree-cli-session.mjs <prepared.json> [--cli-path <installed playwright-cli.js>]');
  }
  const manifest = readManifest(manifestPath);
  const session = await openWorktreeCli(manifest, { cliPath });
  console.log(JSON.stringify({ status: 'ready', session: manifest.isolationId, probe: session.probe.matched }));
}

export function runCli(args) {
  return main(args).catch(error => {
    console.error(JSON.stringify({ status: 'blocked', error: error.message }));
    process.exitCode = 1;
  });
}

if (isCliEntry(import.meta)) await runCli(process.argv.slice(2));
