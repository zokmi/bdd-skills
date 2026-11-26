import { reviewableScenarios } from './module-index.mjs';

export function lint({ modules, orphans }) {
  const problems = [];
  const add = (rule, module, file, line, message) => problems.push({ rule, module, file, line, message });
  const prefixes = new Map();
  for (const m of modules) {
    if (m.error) {
      add('module-format', m.name, m.file, null, m.error);
      continue;
    }
    if (!/^[A-Z]{2,3}$/.test(m.prefix)) add('module-format', m.name, m.file, null, "前綴必須是 2–3 個大寫英文字母：'" + m.prefix + "'");
    if (!m.paths.length) add('module-format', m.name, m.file, null, '缺少 paths（對應程式路徑）');
    if (m.prefix) {
      if (!prefixes.has(m.prefix)) prefixes.set(m.prefix, []);
      prefixes.get(m.prefix).push(m.name);
    }
  }
  for (const prefix of [...prefixes.keys()].sort((a, b) => a.localeCompare(b))) {
    const names = prefixes.get(prefix);
    if (names.length > 1) add('duplicate-prefix', names.join('、'), null, null, '前綴 ' + prefix + ' 被多個模組使用');
  }
  for (const file of orphans) add('orphan-feature', null, file, null, '情境檔所在目錄沒有 MODULE.md');
  for (const m of modules) {
    const seen = new Map();
    for (const file of m.features()) {
      const feature = file.feature;
      for (const { line, title, ids, tags, methods } of reviewableScenarios(file)) {
        const report = (rule, message) => add(rule, m.name, feature, line, message);
        if (ids.length !== 1) {
          report('scenario-id', '情境必須剛好有一個編號標籤：' + title);
          continue;
        }
        const [id] = ids;
        if (id.split('-')[0] !== m.prefix) report('unknown-prefix', '編號 ' + id + ' 的前綴不是本模組登記的 ' + m.prefix);
        const location = feature + ':' + line;
        if (seen.has(id)) report('duplicate-id', '編號 ' + id + ' 重複於 ' + seen.get(id) + ' 與 ' + location);
        else seen.set(id, location);
        if (m.removed.some(r => r.toUpperCase() === id)) report('reused-id', '編號 ' + id + ' 已在 MODULE.md 記為移除，不可再用');
        if (!tags.some(t => /^@#\d+$/.test(t))) report('missing-issue-tag', '情境缺少單號標籤（例如 @#5349）：' + title);
        if (!methods.length) report('missing-method-tag', '情境缺少 @UI／@API／@DB：' + title);
      }
    }
  }
  return problems;
}
