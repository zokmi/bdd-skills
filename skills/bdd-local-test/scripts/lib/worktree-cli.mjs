import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { readManifest, startProbe, validateIsolation } from '../probe-cli-route.mjs';

const execute = promisify(execFile);

function launchSpec(cliPath) {
  if (cliPath !== undefined) {
    if (!path.isAbsolute(cliPath)) throw new Error('Expected an absolute Playwright CLI entry point');
    const file = fs.statSync(cliPath, { throwIfNoEntry: false });
    if (!file?.isFile() || !file.size) throw new Error('The selected Playwright CLI file is missing or empty');
    return [process.execPath, [cliPath]];
  }
  if (process.platform !== 'win32') return ['playwright-cli', []];

  // Windows npm uses a .cmd shim. Invoke its package with argv intact instead of a shell.
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (!fs.existsSync(path.join(dir, 'playwright-cli.cmd'))) continue;
    const entry = '@playwright/cli/playwright-cli.js';
    for (const file of [path.join(dir, 'node_modules', entry), path.resolve(dir, '..', entry)]) {
      if (fs.existsSync(file)) return [process.execPath, [file]];
    }
  }
  throw new Error('Cannot find playwright-cli on PATH. Install @playwright/cli or supply --cli-path to its playwright-cli.js.');
}

export async function runPlaywrightCli(sessionName, args, { cwd = process.cwd(), cliPath } = {}) {
  if (typeof sessionName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionName)) {
    throw new Error('Expected a named Playwright CLI session using letters, numbers, hyphens or underscores');
  }
  const [command, prefix] = launchSpec(cliPath);
  let stdout;
  try {
    ({ stdout } = await execute(command, [...prefix, '-s=' + sessionName, ...args, '--json'], {
      cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 90000,
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    }));
  } catch (error) {
    let detail;
    try {
      const parsed = JSON.parse(error.stdout);
      detail = parsed.error ?? parsed.result?.error;
    } catch {}
    throw new Error('Playwright CLI ' + args[0] + ' failed: ' +
      (detail || error.stderr?.trim() || error.signal || error.code));
  }
  const result = JSON.parse(stdout);
  const action = args[0] === 'open' || args[0] === 'attach' ? result?.result : result;
  if (result?.isError || action?.isError) {
    throw new Error('Playwright CLI ' + args[0] + ' failed: ' + (result.error ?? action.error));
  }
  return result;
}

export async function openWorktreeCli(manifest, { cliPath = manifest?.cliPath } = {}) {
  validateIsolation(manifest);
  const { configPath, isolationId, preflight, storageState } = manifest;
  if (!path.isAbsolute(configPath ?? '') || !path.isAbsolute(preflight.root ?? '')) {
    throw new Error('Expected absolute config and worktree paths');
  }
  const { browser } = readManifest(configPath);
  const resolver = '--host-resolver-rules=MAP localhost ' + preflight.ip;
  const args = browser?.launchOptions?.args;
  if (browser?.browserName !== 'chromium' || browser.isolated !== true || !Array.isArray(args) ||
      args.filter(arg => arg.startsWith('--host-resolver-rules')).join('') !== resolver) {
    throw new Error('Playwright CLI config does not match the allocated localhost resolver');
  }
  const run = (...args) => runPlaywrightCli(isolationId, args, { cwd: preflight.root, cliPath });
  let closed = false;
  async function close() {
    if (!closed) {
      await run('close');
      closed = true;
    }
  }

  // CLI open replaces an existing named browser. Serialize startup for this manifest.
  const lockPath = configPath + '.starting';
  fs.closeSync(fs.openSync(lockPath, 'wx', 0o600));
  try {
    const { browsers } = await run('list');
    if (browsers.some(browser => browser.name === isolationId)) {
      throw new Error('The prepared Playwright CLI session is already open: ' + isolationId);
    }
    try {
      await run('open', '--config=' + configPath);
      const probe = await startProbe(manifest);
      try {
        await run('goto', probe.ready.url);
        const matched = await probe.matched;
        if (!matched) throw new Error('Playwright CLI did not reach the allocated localhost IP');
        if (storageState) await run('state-load', storageState);
        return { run, close, closed: () => closed, probe: { ready: probe.ready, matched } };
      } finally {
        probe.close();
      }
    } catch (error) {
      await close();
      throw error;
    }
  } finally {
    fs.unlinkSync(lockPath);
  }
}
