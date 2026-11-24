import readline from 'node:readline';
import { isCliEntry } from './lib/cli-entry.mjs';
import { openWorktreeMcp, readManifest } from './lib/worktree-mcp.mjs';
import { captureEvidence } from './lib/evidence-screenshot.mjs';

async function main([manifestPath, flag, mcpCli, ...extra]) {
  if (!manifestPath || extra.length || (flag && (flag !== '--mcp-cli' || !mcpCli))) {
    throw new Error('Usage: node worktree-mcp-session.mjs <prepared.json> [--mcp-cli <installed cli.js>]');
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const requests = input[Symbol.asyncIterator]();
  const stop = () => input.close();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let session;
  try {
    const manifest = readManifest(manifestPath);
    session = await openWorktreeMcp(manifest, { mcpCli });
    console.log(JSON.stringify({ status: 'ready', probe: session.probe.matched }));
    for await (const line of requests) {
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
        const { id, tool, args } = request;
        if (tool === 'close') break;
        let result;
        if (tool === 'tools/list') result = await session.listTools();
        else if (tool === 'bdd/screenshot') result = await captureEvidence(session, manifest.preflight.root, args);
        else result = await session.call(tool, args);
        console.log(JSON.stringify({ id, result }));
      } catch (error) {
        console.log(JSON.stringify({ id: request?.id, error: error.message }));
        if (session.closed()) throw error;
      }
    }
  } finally {
    input.close();
    await session?.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export function runCli(args) {
  return main(args).catch(error => {
    console.error(JSON.stringify({ status: 'blocked', error: error.message }));
    process.exitCode = 1;
  });
}

if (isCliEntry(import.meta)) {
  runCli(process.argv.slice(2));
}

export { main };
