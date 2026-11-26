import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parsePorts } from '../scripts/lib/loopback-slot.mjs';
import { worktreeFixture } from './worktree-fixture.mjs';

const { values } = parseArgs({ options: {
  'cli-path': { type: 'string' }, 'chrome-path': { type: 'string' }, 'output-dir': { type: 'string' },
  'use-default-registry': { type: 'boolean' }, 'ui-port': { type: 'string', default: '4200' },
  'api-port': { type: 'string', default: '9453' },
} });
if (!values['chrome-path'] || !values['output-dir']) throw new Error('Specify --chrome-path and --output-dir.');
const [uiPort, apiPort] = ['ui-port', 'api-port'].map(key => {
  const ports = parsePorts([values[key]]);
  if (ports.length !== 1) throw new Error('Expected one port for --' + key);
  return ports[0];
});
assert.notEqual(uiPort, apiPort, 'UI and API test ports must differ');
const chrome = path.resolve(values['chrome-path']);
assert.ok(fs.statSync(chrome).isFile(), 'Expected a Chrome executable');
const cli = values['cli-path'] ? ['--cli-path', path.resolve(values['cli-path'])] : [];
const outputDir = path.resolve(values['output-dir']);
fs.mkdirSync(outputDir, { recursive: true });
const fixture = worktreeFixture({ defaultRegistry: values['use-default-registry'] });
try {
  const services = [];
  for (const name of ['project-a', 'project-b']) {
    const main = fixture.init(name);
    for (const suffix of ['main', 'one', 'two']) {
      const id = name + '-' + suffix;
      const checkout = suffix === 'main' ? main : fixture.worktree(main, id);
      const prepared = await fixture.bdd(checkout, 'prepare-worktree-cli', '--ports', String(uiPort), '--ports',
        String(apiPort), '--keep-original-ports', '--output-dir', path.join(outputDir, id),
        ...cli, ...(suffix === 'main' ? ['--isolate'] : []));
      const config = JSON.parse(fs.readFileSync(prepared.configPath, 'utf8'));
      config.browser.launchOptions.executablePath = chrome;
      fs.writeFileSync(prepared.configPath, JSON.stringify(config, null, 2));
      services.push({ id, ip: prepared.preflight.ip, isolationId: prepared.isolationId, prepared });
    }
  }
  assert.equal(new Set(services.map(s => s.ip)).size, 6);
  const manifest = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ services, outputDir, uiPort, apiPort }, null, 2));
  execFileSync(process.execPath, [fileURLToPath(new URL('./loopback-live.mjs', import.meta.url)), manifest],
    { stdio: 'inherit', windowsHide: true });
} finally {
  await fixture.clean();
}
