import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function findBddOutputConfig(dir, mainCheckout) {
  const local = path.join(path.dirname(path.resolve(dir)), 'config.json');
  if (fs.existsSync(local)) return local;
  if (mainCheckout === undefined) {
    const output = spawnSync('git', ['-C', dir, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', windowsHide: true });
    const first = output.stdout?.split('\0', 1)[0];
    if (output.status === 0 && first?.startsWith('worktree ')) mainCheckout = first.slice('worktree '.length);
  }
  if (!mainCheckout) return null;
  const fallback = path.resolve(mainCheckout, '.bdd', 'config.json');
  return fs.existsSync(fallback) ? fallback : null;
}

export function loadBddOutputConfig(dir, mainCheckout) {
  const file = findBddOutputConfig(dir, mainCheckout);
  const config = file ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  return { file, config };
}

export function readBddOutputConfig(dir, mainCheckout) {
  return loadBddOutputConfig(dir, mainCheckout).config;
}
