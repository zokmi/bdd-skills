// Compatibility entry point for older skill installations and scripts.
import('./bdd.mjs').then(({ runCli }) => runCli(process.argv.slice(2)));
