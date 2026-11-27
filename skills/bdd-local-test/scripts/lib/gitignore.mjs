import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const begin = '# BEGIN bdd-skills managed ignores';
const end = '# END bdd-skills managed ignores';
const rules = [
  '/.bdd/', '!/.bdd/', '/.bdd/*', '!/.bdd/modules/', '!/.bdd/config.json',
  '/.bdd/modules/**/*', '!/.bdd/modules/**/', '!/.bdd/modules/**/*.feature', '!/.bdd/modules/**/MODULE.md',
];
const probes = [
  '.bdd/__bdd_ignore_probe__/REPORT.md', '.bdd/__bdd_ignore_probe__/shot.png',
  '.bdd/modules/__bdd_ignore_probe__/case.feature', '.bdd/modules/__bdd_ignore_probe__/MODULE.md',
  '.bdd/modules/__bdd_ignore_probe__/log.txt', '.bdd/modules/root.feature', '.bdd/config.json',
];

function git(repo, args, statuses = [0], input) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', '-C', repo, ...args], {
    encoding: 'utf8', input, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!statuses.includes(result.status)) throw new Error(result.stderr.trim() || 'Git command failed.');
  return result;
}

function isSource(file) {
  return file === '.bdd/config.json' || /^\.bdd\/modules\/(?:[\s\S]*\/)?(?:[^/]+\.feature|MODULE\.md)$/.test(file);
}

function listPaths(repo, ...args) {
  return git(repo, ['ls-files', '-z', ...args, '--', '.bdd/']).stdout.split('\0').filter(Boolean);
}

export function isIgnoredPath(repo, relative) {
  const file = './' + relative.split(path.sep).join('/');
  return git(repo, ['check-ignore', '-q', '--', file], [0, 1]).status === 0;
}

function* ignoreFieldBatches(repo, files) {
  let maxPaths = 4096;
  for (let start = 0; start < files.length;) {
    let end = start;
    let bytes = 0;
    while (end < files.length && end - start < maxPaths) {
      const size = Buffer.byteLength(files[end]) + 1;
      if (end > start && bytes + size > 256 * 1024) break;
      bytes += size;
      end++;
    }
    const input = files.slice(start, end).join('\0') + '\0';
    let output;
    try {
      output = git(repo, ['check-ignore', '--no-index', '-z', '-v', '--non-matching', '--stdin'], [0, 1], input).stdout;
    } catch (error) {
      // Verbose output repeats the matching rule for each path. Long rules can exceed maxBuffer.
      if (error.code !== 'ENOBUFS' || end - start === 1) throw error;
      maxPaths = Math.ceil((end - start) / 2);
      continue;
    }
    yield output.split('\0');
    start = end;
  }
}

function findFailures(repo) {
  const files = [...new Set([...probes, ...listPaths(repo, '--cached', '--others')])].sort();
  const failures = [];
  for (const fields of ignoreFieldBatches(repo, files)) {
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const [source, line, pattern, file] = fields.slice(i, i + 4);
      const expectedIgnored = !isSource(file);
      const ignored = Boolean(source) && !pattern.startsWith('!');
      if (ignored === expectedIgnored) continue;
      let detail = '';
      if (source) {
        // Let Git quote control characters and special path names in its display format.
        detail = /[\x00-\x1f\x7f"\\]/.test(file + source)
          ? git(repo, ['check-ignore', '--no-index', '-v', '--', file], [0, 1]).stdout.trimEnd()
          : (source + ':' + line + ':' + pattern + '\t' + file).trimEnd();
      }
      failures.push({ path: file, expectedIgnored, rule: detail ? [detail] : [] });
    }
  }
  return failures;
}

export function ensureGitignore(repo, check) {
  const top = git(repo, ['rev-parse', '--show-toplevel'], [0, 128]);
  if (top.status !== 0) throw new Error('Repo must be a Git working tree.');
  const root = top.stdout.replace(/\r?\n$/, '');
  const trackedOutputs = listPaths(root).filter(file => !isSource(file));
  const failures = findFailures(root);
  if (check || !failures.length) return { repo: root, updated: false, failures, trackedOutputs };

  const ignore = path.join(root, '.gitignore');
  const originalStat = fs.lstatSync(ignore, { throwIfNoEntry: false });
  if (originalStat?.isDirectory()) throw new Error('.gitignore is a directory.');
  if (originalStat && (!originalStat.isFile() || originalStat.nlink !== 1)) throw new Error('Refusing to edit a linked or non-regular .gitignore.');
  const original = originalStat ? fs.readFileSync(ignore) : Buffer.alloc(0);
  let encoding = 'utf-8';
  if (original[0] === 0xff && original[1] === 0xfe) encoding = 'utf-16le';
  if (original[0] === 0xfe && original[1] === 0xff) encoding = 'utf-16be';
  const content = new TextDecoder(encoding).decode(original);
  if (content.includes(begin) || content.includes(end)) {
    throw new Error('Managed ignore block exists but validation fails; inspect conflicting rules before editing.');
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const prefix = content && !content.endsWith('\n') ? newline : '';
  const addition = Buffer.from(prefix + [begin, ...rules, end, ''].join(newline));
  const handle = fs.openSync(ignore, originalStat ? 'r+' : 'wx+');
  const opened = fs.fstatSync(handle);
  try {
    if ((originalStat && (originalStat.dev !== opened.dev || originalStat.ino !== opened.ino)) ||
        opened.nlink !== 1 || !fs.readFileSync(handle).equals(original)) throw new Error('.gitignore changed during preflight; retry.');
    try {
      fs.writeFileSync(handle, addition);
      if (findFailures(root).length) throw new Error('Conflicting nested ignore rules; automatic changes rolled back.');
    } catch (error) {
      const current = fs.lstatSync(ignore, { throwIfNoEntry: false });
      if (current && current.dev === opened.dev && current.ino === opened.ino && current.nlink === 1) {
        const bytes = fs.readFileSync(ignore);
        const appended = bytes.subarray(original.length);
        if (bytes.subarray(0, original.length).equals(original) && appended.equals(addition.subarray(0, appended.length))) {
          if (originalStat) fs.ftruncateSync(handle, original.length);
          else fs.unlinkSync(ignore);
        } else throw new Error('.gitignore changed during validation; further edits have been preserved.');
      }
      throw error;
    }
  } finally {
    fs.closeSync(handle);
  }
  return { repo: root, updated: true, failures: [], trackedOutputs };
}
