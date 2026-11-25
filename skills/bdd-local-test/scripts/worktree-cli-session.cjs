if (require.main === module) {
  import('./worktree-cli-session.mjs').then(({ runCli }) => runCli(process.argv.slice(2)));
} else {
  const { main } = require('./worktree-cli-session.mjs');
  module.exports = { main };
}
