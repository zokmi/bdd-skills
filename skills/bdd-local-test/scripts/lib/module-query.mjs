import { parseArgs } from 'node:util';
import { changedPaths, commit, repoRoot } from './git-changes.mjs';
import { lint } from './module-lint.mjs';
import { moduleIndex, repositoryImpact, nextId } from './module-index.mjs';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const repoOption = { type: 'string', default: '.' };

function moduleChanges(repo, ref) {
  const base = commit(repo, ref);
  if (ref === 'HEAD') return changedPaths(repo, base, base);
  try {
    return changedPaths(repo, base, commit(repo, 'HEAD'));
  } catch {
    // An unborn HEAD or unrelated histories must retain Git's original <base>...HEAD diagnostic.
    return changedPaths(repo, base, 'HEAD');
  }
}

export function modulesCommand(args) {
  const { values: v } = parseArgs({ args, options: {
    repo: repoOption, lint: boolean, 'next-id': boolean, module: string, path: { type: 'string', multiple: true }, base: string,
  } });
  if ([v.lint, v['next-id'], v.path !== undefined || v.base !== undefined].filter(Boolean).length !== 1) {
    throw new Error('請擇一指定 --lint、--next-id 或 --path／--base');
  }
  const repo = repoRoot(v.repo);
  if (v['next-id'] && !v.module) throw new Error('--next-id 需要 --module');
  if (v.lint) {
    const index = moduleIndex(repo);
    const problems = lint(index);
    console.log(JSON.stringify({ repo, modules: index.modules.length, problems }));
    return problems.length ? 1 : 0;
  }
  if (v['next-id']) {
    const [m] = moduleIndex(repo, { moduleName: v.module }).modules;
    if (!m) throw new Error('找不到模組：' + v.module);
    if (m.error) throw new Error('模組的 MODULE.md 有錯誤：' + m.error);
    console.log(JSON.stringify({ module: m.name, prefix: m.prefix, next: nextId(m) }));
  } else {
    const paths = (v.path || []).concat(v.base ? moduleChanges(repo, v.base) : []);
    console.log(JSON.stringify({ repo, ...repositoryImpact(repo, paths) }));
  }
  return 0;
}
