if (require.main === module) {
  import('./probe-mcp-route.mjs').then(({ runCli }) => runCli(process.argv.slice(2)));
} else {
  const { main, readManifest, startProbe, validateIsolation } = require('./probe-mcp-route.mjs');
  module.exports = { main, readManifest, startProbe, validateIsolation };
}
