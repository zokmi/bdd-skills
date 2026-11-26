import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { tag: { type: 'string' } } });
const versionOf = file => JSON.parse(readFileSync(file, 'utf8')).version;
const version = versionOf('plugin.json');
if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('Invalid plugin version: ' + version);
}
for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
  if (versionOf(file) !== version) throw new Error(file + ' version must match plugin.json');
}
if (values.tag !== undefined) {
  if (values.tag !== 'v' + version) throw new Error('Release tag must match plugin.json: expected v' + version);
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], { stdio: 'inherit' });
}
console.log('Plugin version ' + version + ' verified.');
