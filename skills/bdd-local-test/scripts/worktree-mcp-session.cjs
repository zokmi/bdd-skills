const readline = require('node:readline');
const { openWorktreeMcp, readManifest } = require('./lib/worktree-mcp.cjs');

async function main([manifestPath, flag, mcpCli, ...extra]) {
  if (!manifestPath || extra.length || (flag && (flag !== '--mcp-cli' || !mcpCli))) {
    throw new Error('Usage: node worktree-mcp-session.cjs <prepared.json> [--mcp-cli <installed cli.js>]');
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const requests = input[Symbol.asyncIterator]();
  const stop = () => input.close();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let session;
  try {
    session = await openWorktreeMcp(readManifest(manifestPath), { mcpCli });
    console.log(JSON.stringify({ status: 'ready', probe: session.probe.matched }));
    for await (const line of requests) {
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
        const { id, tool, args } = request;
        if (tool === 'close') break;
        const result = tool === 'tools/list' ? await session.listTools() : await session.call(tool, args);
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

main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ status: 'blocked', error: error.message }));
  process.exitCode = 1;
});
