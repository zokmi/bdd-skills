if (require.main === module) {
  import('./worktree-mcp-session.mjs').then(({ runCli }) => runCli(process.argv.slice(2)));
} else {
  const { main } = require('./worktree-mcp-session.mjs');
  module.exports = { main };
}
