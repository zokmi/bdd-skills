if (require.main === module) {
  import('./probe-cli-route.mjs').then(({ runCli }) => runCli(process.argv.slice(2)));
} else {
  const { main, readManifest, startProbe, validateIsolation } = require('./probe-cli-route.mjs');
  module.exports = { main, readManifest, startProbe, validateIsolation };
}
