import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function compileWindowsTool(name, source, references) {
  if (process.platform !== 'win32') throw new Error(name + ' requires Windows.');
  const framework = path.join(process.env.SystemRoot, 'Microsoft.NET');
  const csc = ['Framework64', 'Framework'].map(dir => path.join(framework, dir, 'v4.0.30319', 'csc.exe')).find(file => fs.existsSync(file));
  if (!csc) throw new Error('The Windows .NET Framework C# compiler is unavailable.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-' + name + '-'));
  const exe = path.join(dir, name + '.exe');
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  try {
    await run(csc, ['/nologo', '/noconfig', '/target:exe', '/optimize+', ...references.map(ref => '/r:' + ref), '/out:' + exe, source], {
      cwd: dir, windowsHide: true, env: { ...process.env, TMP: dir, TEMP: dir },
    });
  } catch (error) {
    throw new Error('Cannot compile ' + name + ': ' + (error.stdout || error.stderr || error.message).trim());
  }
  return exe;
}
