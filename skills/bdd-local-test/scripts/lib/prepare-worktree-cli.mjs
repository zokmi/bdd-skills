import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { allocateSlot, parsePorts } from './loopback-slot.mjs';
import { writeNewFile } from './write-new-file.mjs';

function existingFile(input, label) {
  if (input === undefined) return;
  const file = path.resolve(input);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || !stat.size) throw new Error(label + ' must be an existing, nonempty file.');
  return file;
}

export async function prepareWorktreeCli(args) {
  const { values } = parseArgs({ args, options: {
    ports: { type: 'string', multiple: true }, 'output-dir': { type: 'string' },
    isolate: { type: 'boolean' }, 'keep-original-ports': { type: 'boolean' },
    'storage-state': { type: 'string' }, 'cli-path': { type: 'string' }, manifest: { type: 'string' },
  } });
  const ports = parsePorts(values.ports ?? []);
  if (!ports.length || !values['output-dir']) throw new Error('Expected --ports and --output-dir.');
  const state = existingFile(values['storage-state'], 'StorageState');
  const cliPath = existingFile(values['cli-path'], 'CliPath');
  const output = path.resolve(values['output-dir']);
  if (values.manifest === '') throw new Error('Expected a file path for --manifest.');
  const manifest = values.manifest && path.resolve(values.manifest);
  if (manifest && fs.lstatSync(manifest, { throwIfNoEntry: false })) throw new Error('Manifest already exists: ' + manifest);
  const preflight = await allocateSlot({ ports, isolate: values.isolate, keepOriginalPorts: values['keep-original-ports'] });
  const isolationId = 'bdd-cli-' + randomUUID().replaceAll('-', '');
  const configPath = path.join(output, isolationId + '.json');
  const config = {
    browser: { browserName: 'chromium', isolated: true, launchOptions: { channel: 'chrome', args: preflight.isolated ? [preflight.chromiumArg] : [] } },
    outputDir: path.join(output, isolationId),
  };
  const prepared = JSON.stringify({
    isolationId, configPath, ports, portMappings: preflight.portMappings, effectivePorts: preflight.effectivePorts,
    preflight, status: 'configuration-only',
    verificationRequired: ['獨立 Playwright CLI 工作階段與瀏覽器', '前端及 API 的實際目標 IP、本輪有效埠與受測版本', '帳號及資料範圍隔離'],
    ...(state ? { storageState: state } : {}),
    ...(cliPath ? { cliPath } : {}),
  });
  fs.mkdirSync(output, { recursive: true });
  const fd = fs.openSync(configPath, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(config, null, 2)); } finally { fs.closeSync(fd); }
    if (manifest) writeNewFile(manifest, prepared + '\n', 0o600);
  } catch (error) {
    fs.unlinkSync(configPath);
    throw error;
  }
  console.log(prepared);
  return 0;
}
