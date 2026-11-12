const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

function git(repo, args, statuses = [0]) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', '-C', repo, ...args], { encoding: 'utf8' });
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

function findFailures(repo) {
  const files = [...new Set([...probes, ...listPaths(repo, '--cached', '--others')])].sort();
  const failures = [];
  for (const file of files) {
    const expectedIgnored = !isSource(file);
    const args = ['check-ignore', '--no-index'];
    const ignored = git(repo, [...args, '-q', '--', file], [0, 1]).status === 0;
    if (ignored !== expectedIgnored) {
      const detail = git(repo, [...args, '-v', '--', file], [0, 1]).stdout.trimEnd();
      failures.push({ path: file, expectedIgnored, rule: detail ? [detail] : [] });
    }
  }
  return failures;
}

function ensureGitignore(repo, check) {
  const root = git(repo, ['rev-parse', '--show-toplevel']).stdout.replace(/\r?\n$/, '');
  const trackedOutputs = listPaths(root).filter(file => !isSource(file));
  const failures = findFailures(root);
  if (check || !failures.length) return { repo: root, updated: false, failures, trackedOutputs };

  const ignore = path.join(root, '.gitignore');
  const originalStat = fs.lstatSync(ignore, { throwIfNoEntry: false });
  if (originalStat && !originalStat.isFile()) throw new Error('Refusing to edit a non-regular .gitignore.');
  const original = originalStat ? fs.readFileSync(ignore) : Buffer.alloc(0);
  const content = original.toString('utf8');
  if (content.includes(begin) || content.includes(end)) {
    throw new Error('Managed ignore block exists but validation fails; inspect conflicting rules before editing.');
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const prefix = content && !content.endsWith('\n') ? newline : '';
  const addition = Buffer.from(prefix + [begin, ...rules, end, ''].join(newline));
  const handle = fs.openSync(ignore, originalStat ? 'r+' : 'wx+');
  try {
    if (!fs.readFileSync(handle).equals(original)) throw new Error('.gitignore changed during preflight; retry.');
    try {
      fs.writeFileSync(handle, addition);
      if (findFailures(root).length) throw new Error('Conflicting nested ignore rules; automatic changes rolled back.');
    } catch (error) {
      fs.ftruncateSync(handle, original.length);
      throw error;
    }
  } catch (error) {
    fs.closeSync(handle);
    if (!originalStat) fs.unlinkSync(ignore);
    throw error;
  }
  fs.closeSync(handle);
  return { repo: root, updated: true, failures: [], trackedOutputs };
}

module.exports = { ensureGitignore };
