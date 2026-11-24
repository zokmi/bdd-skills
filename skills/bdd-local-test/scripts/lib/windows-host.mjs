import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compileWindowsTool } from './windows-compiler.mjs';

const run = promisify(execFile);
const source = fileURLToPath(new URL('./windows-host.cs', import.meta.url));
let compilation;

function host() {
  compilation ??= compileWindowsTool('windows-host', source, ['System.dll', 'System.Core.dll', 'System.Management.dll', 'System.Web.Extensions.dll']);
  return compilation;
}

async function hostJson(args) {
  const exe = await host();
  const { stdout } = await run(exe, args, { cwd: path.dirname(exe), windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export const listListeners = () => hostJson(['listeners']);
export const listProcesses = () => hostJson(['processes']);
export const terminateTree = (pid, created) => hostJson(['terminate', String(pid), String(created)]);
export async function processNames(pids) {
  if (!pids.length) return new Map();
  const names = await hostJson(['names', ...new Set(pids.map(String))]);
  return new Map(names.map(({ pid, name }) => [pid, name]));
}

export async function withAllocationLocks(registryDir, commonDir, callback) {
  const exe = await host();
  const child = spawn(exe, ['lock', registryDir, commonDir], {
    cwd: path.dirname(exe), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  const lines = createInterface({ input: child.stdout });
  // Close/EOF releases the two OS locks even if the Node process is interrupted.
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(diagnostic.trim() || 'Slot lock helper exited: ' + (code ?? signal)));
    });
  });
  const inputError = new Promise((_, reject) => child.stdin.on('error', reject));
  function expectLine(expected) {
    return Promise.race([
      new Promise((resolve, reject) => lines.once('line', line =>
        line === expected ? resolve() : reject(new Error('Invalid slot lock helper response.')))),
      closed.then(() => { throw new Error('Slot lock helper exited before ' + expected); }),
      inputError,
    ]);
  }
  async function publish(changes) {
    // Delegate *both* writes to the process holding the OS locks. If it dies,
    // a delayed allocation callback cannot overwrite a subsequent owner's files.
    const ack = expectLine('published');
    child.stdin.write(JSON.stringify(changes) + '\n');
    await ack;
  }
  try {
    await expectLine('ready');
    return await callback(publish);
  } finally {
    child.stdin.end();
    lines.close();
    await closed;
  }
}
