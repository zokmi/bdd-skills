import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkIgnoredPaths, isIgnoredPath } from './gitignore.mjs';
import { git } from './verification-git.mjs';

function within(relative) {
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

// Saving a plan or its review table must leave every reviewed worktree at its captured revision.
export function resolveNewOutput(repos, requested, option) {
  if (!requested.trim()) throw new Error(option + ' 須指定新檔案');
  const parent = fs.realpathSync.native(path.dirname(path.resolve(requested)));
  const file = path.join(parent, path.basename(requested));
  const roots = [...new Set(repos)].map(repo => fs.realpathSync.native(repo));
  const affected = roots.filter(repo => within(path.relative(repo, file)));
  // A rule may ignore just the destination. A concurrent Git status must not see the staging name either.
  const extension = path.extname(file);
  const tempName = '.bdd-tmp-' + randomUUID() + (affected.length && extension.length <= 16 ? extension : '');
  const sibling = path.join(parent, tempName);
  let canStageBesideFile = true;
  for (const repo of affected) {
    const [fileIgnored, siblingIgnored] = checkIgnoredPaths(repo, [path.relative(repo, file), path.relative(repo, sibling)]);
    if (!fileIgnored) throw new Error(option + ' 請使用被 Git 忽略的輸出目錄或工作區外的新檔案');
    if (!siblingIgnored) canStageBesideFile = false;
  }
  if (canStageBesideFile) return { file, staged: sibling };

  const device = fs.statSync(parent, { bigint: true }).dev;
  const candidates = affected.map(repo => git(repo, ['rev-parse', '--absolute-git-dir']).trimEnd());
  for (const dir of [...new Set(candidates), os.tmpdir()]) {
    const realDir = fs.realpathSync.native(dir);
    if (fs.statSync(realDir, { bigint: true }).dev !== device) continue;
    const staged = path.join(realDir, tempName);
    const hidden = roots.every(repo => {
      const relative = path.relative(repo, staged);
      return !within(relative) || relative.split(path.sep).includes('.git') || isIgnoredPath(repo, relative);
    });
    if (hidden) return { file, staged };
  }
  throw new Error(option + ' 找不到與目的檔同磁碟且不影響受審工作樹的暫存位置，請使用被 Git 忽略的目錄');
}

export function writeNewFile(file, content, mode = 0o666, staged = path.join(path.dirname(file), '.bdd-tmp-' + randomUUID())) {
  const fd = fs.openSync(staged, 'wx', mode);
  try {
    try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
    // Publish complete contents without replacing a destination won by another writer.
    fs.linkSync(staged, file);
  } finally { fs.unlinkSync(staged); }
}
