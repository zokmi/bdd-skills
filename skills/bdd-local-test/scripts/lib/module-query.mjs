import { parseArgs } from 'node:util';
import { changedPaths, commit, repoRoot } from './git-changes.mjs';
import { lint } from './module-lint.mjs';
import { moduleIndex, findImpact, nextId } from './module-index.mjs';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const repoOption = { type: 'string', default: '.' };

export function modulesCommand(args) {
  const { values: v } = parseArgs({ args, options: {
    repo: repoOption, lint: boolean, 'next-id': boolean, module: string, path: { type: 'string', multiple: true }, base: string,
  } });
  if ([v.lint, v['next-id'], v.path !== undefined || v.base !== undefined].filter(Boolean).length !== 1) {
    throw new Error('請擇一指定 --lint、--next-id 或 --path／--base');
  }
  const repo = repoRoot(v.repo);
  const index = moduleIndex(repo);
  if (v.lint) {
    const problems = lint(index);
    console.log(JSON.stringify({ repo, modules: index.modules.length, problems }));
    return problems.length ? 1 : 0;
  }
  if (v['next-id']) {
    if (!v.module) throw new Error('--next-id 需要 --module');
    const name = v.module.replaceAll('\\', '/').toLowerCase();
    const m = index.modules.find(m => m.name.toLowerCase() === name);
    if (!m) throw new Error('找不到模組：' + v.module);
    if (m.error) throw new Error('模組的 MODULE.md 有錯誤：' + m.error);
    console.log(JSON.stringify({ module: m.name, prefix: m.prefix, next: nextId(m) }));
  } else {
    let paths = v.path || [];
    if (v.base) {
      const baseline = commit(repo, v.base);
      paths = paths.concat(changedPaths(repo, baseline, 'HEAD', false));
    }
    console.log(JSON.stringify({ repo, ...findImpact(index.modules, paths) }));
  }
  return 0;
}
