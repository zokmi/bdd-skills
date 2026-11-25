import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { allocateSlot, parsePorts } from './loopback-slot.mjs';

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
    'storage-state': { type: 'string' }, 'cli-path': { type: 'string' },
  } });
  const ports = parsePorts(values.ports ?? []);
  if (!ports.length || !values['output-dir']) throw new Error('Expected --ports and --output-dir.');
  const state = existingFile(values['storage-state'], 'StorageState');
  const cliPath = existingFile(values['cli-path'], 'CliPath');
  const output = path.resolve(values['output-dir']);
  const preflight = await allocateSlot({ ports, isolate: values.isolate, keepOriginalPorts: values['keep-original-ports'] });
  const isolationId = 'bdd-cli-' + randomUUID().replaceAll('-', '');
  const configPath = path.join(output, isolationId + '.json');
  const config = {
    browser: { browserName: 'chromium', isolated: true, launchOptions: { channel: 'chrome', args: preflight.isolated ? [preflight.chromiumArg] : [] } },
    outputDir: path.join(output, isolationId),
  };
  fs.mkdirSync(output, { recursive: true });
  const fd = fs.openSync(configPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(configPath);
    throw error;
  }
  fs.closeSync(fd);
  console.log(JSON.stringify({
    isolationId, configPath, ports, portMappings: preflight.portMappings, effectivePorts: preflight.effectivePorts,
    preflight, status: 'configuration-only',
    verificationRequired: ['獨立 Playwright CLI 工作階段與瀏覽器', '前端及 API 的實際目標 IP、本輪有效埠與受測版本', '帳號及資料範圍隔離'],
    ...(state ? { storageState: state } : {}),
    ...(cliPath ? { cliPath } : {}),
  }));
  return 0;
}
