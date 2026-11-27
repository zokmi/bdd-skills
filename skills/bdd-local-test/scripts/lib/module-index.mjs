import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const relative = (root, file) => path.relative(root, file).split(path.sep).join('/') || '.';
const compare = (a, b) => a.localeCompare(b);

function metadata(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r\n?|\n/);
  if (lines[0].trim() !== '---') throw new Error('MODULE.md 缺少開頭的 --- front matter：' + file);
  const data = Object.create(null);
  let key;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return data;
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      if (!key) throw new Error('front matter 第 ' + (i + 1) + ' 行的清單項目前面缺少鍵名：' + file);
      data[key].push(item[1]);
      continue;
    }
    const field = line.match(/^([A-Za-z]+):\s*(.*?)\s*$/);
    if (!field) throw new Error('無法解析 front matter 第 ' + (i + 1) + ' 行：' + file);
    key = field[1].toLowerCase();
    data[key] = field[2] ? [field[2]] : [];
  }
  throw new Error('front matter 沒有結尾的 ---：' + file);
}

function readFeature(file, root, hashFeatures, retainedSources) {
  const feature = relative(root, file);
  const bytes = fs.readFileSync(file);
  if (retainedSources?.has(feature)) retainedSources.set(feature, bytes);
  return parseFeature(bytes, feature, hashFeatures);
}

export function parseFeature(bytes, feature, hashFeatures = false) {
  const scenarios = [];
  const unindexedScenarios = [];
  const scenarioIds = tags => tags.filter(t => /^@[A-Z]{2,3}-\d{2,}$/.test(t)).map(t => t.slice(1));
  let tags = [];
  let lastTagLine;
  let docString;
  const lines = bytes.toString('utf8').split(/\r\n?|\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    const delimiter = line.slice(0, 3);
    if (docString) {
      if (delimiter === docString) docString = undefined;
      continue;
    }
    if (delimiter === '"""' || delimiter === '```') {
      docString = delimiter;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@')) {
      tags.push(...line.split(/\s+/).filter(tag => tag.startsWith('@')));
      lastTagLine = i + 1;
      continue;
    }
    const indexedTitle = line.match(/^(?:場景大綱|場景|劇本大綱|劇本|Scenario Outline|Scenario Template|Scenario|Example)\s*[:：]\s*(.*)$/i);
    const title = indexedTitle ?? line.match(/^(?:Démonstration|Scénario|Plan du scénario|Exemple|情境(?:大綱)?|场景(?:大纲)?|剧本(?:大纲)?)\s*[:：]\s*(\S.*)$/iu);
    const ids = scenarioIds(tags);
    if (title) {
      const rows = indexedTitle ? scenarios : unindexedScenarios;
      rows.push({
        line: i + 1, title: title[1], tags, ids,
        methods: tags.filter(t => ['@UI', '@API', '@DB'].includes(t)).map(t => t.slice(1)),
      });
    } else if (ids.length) {
      // Reserve stray IDs for number allocation without treating them as scenarios.
      unindexedScenarios.push({ line: i + 1, ids, unattached: true });
    }
    tags = [];
  }
  const result = { feature, scenarios };
  const trailingIds = scenarioIds(tags);
  if (trailingIds.length) unindexedScenarios.push({ line: lastTagLine, ids: trailingIds, unattached: true });
  if (unindexedScenarios.length) result.unindexedScenarios = unindexedScenarios;
  if (docString) result.unterminatedDocString = true;
  if (unindexedScenarios.length || !scenarios.length || docString) result.requiresFullFeature = true;
  if (hashFeatures) result.sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  return result;
}

// Include supported tagged headings that required full-file review in the quick index.
export function reviewableScenarios(feature) {
  const legacy = (feature.unindexedScenarios ?? []).filter(s => !s.unattached);
  return legacy.length ? feature.scenarios.concat(legacy).sort((a, b) => a.line - b.line) : feature.scenarios;
}

export function declaredScenarioIds(feature) {
  return new Set(reviewableScenarios(feature).flatMap(s => s.ids));
}

export function checkScenarioIds(available, selected, feature) {
  if (!selected.length) throw new Error('情境檔 ' + feature + ' 缺少指定編號');
  const missing = selected.filter(id => !available.has(id.toUpperCase()));
  if (missing.length) throw new Error('情境檔 ' + feature + ' 找不到指定編號：' + missing.join('、'));
}

function moduleIndex(root, { hashFeatures = false, moduleName, retainedSources } = {}) {
  const base = path.join(root, '.bdd', 'modules');
  const modules = [];
  const orphans = [];
  function visit(dir, remaining) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name));
    if (remaining?.length) {
      const [name, ...rest] = remaining;
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase() === name) visit(path.join(dir, entry.name), rest);
      }
      return;
    }
    const files = entries.filter(e => e.isFile() || (e.isSymbolicLink() &&
      fs.statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.isFile()));
    const features = files.filter(e => /\.feature$/i.test(e.name)).map(e => path.join(dir, e.name));
    const manifest = files.find(e => e.name.toLowerCase() === 'module.md');
    if (manifest) {
      const file = path.join(dir, manifest.name);
      let fields = {};
      let error;
      try { fields = metadata(file); } catch (err) { error = err.message; }
      let parsed;
      modules.push({
        name: relative(base, dir), file, error, prefix: (fields.prefix || []).join(' '),
        paths: fields.paths || [], removed: (fields.removed || []).map(s => s.split(/\s+/)[0]),
        features() {
          parsed ??= features.map(file => readFeature(file, root, hashFeatures, retainedSources));
          return parsed;
        },
      });
    } else {
      orphans.push(...features.map(f => relative(root, f)));
    }
    if (remaining === undefined) {
      for (const entry of entries) if (entry.isDirectory()) visit(path.join(dir, entry.name));
    }
  }
  const parts = moduleName === '.' ? [] : moduleName?.replaceAll('\\', '/').toLowerCase().split('/');
  if (fs.statSync(base, { throwIfNoEntry: false })?.isDirectory()) visit(base, parts);
  return { modules: modules.sort((a, b) => compare(a.file, b.file)), orphans };
}

function nextId(m) {
  let max = 0n;
  function consider(id) {
    const match = /^(.*)-(\d+)$/.exec(id);
    if (match && match[1] === m.prefix && BigInt(match[2]) > max) max = BigInt(match[2]);
  }
  for (const id of m.removed) consider(id);
  for (const f of m.features()) {
    for (const s of f.scenarios.concat(f.unindexedScenarios || [])) for (const id of s.ids) consider(id);
  }
  return m.prefix + '-' + String(max + 1n).padStart(2, '0');
}

function globRegex(glob) {
  const pattern = glob.replaceAll('\\', '/').match(/\*\*\/|\*\*|\*|\?|[\s\S]/g) || [];
  const wildcards = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' };
  return new RegExp('^' + pattern.map(c => wildcards[c] ?? c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'i');
}

function impactMatcher(modules, fileCount) {
  // For short queries a linear scan is cheaper than building a directory index.
  if (fileCount < 16 || fileCount * modules.reduce((n, m) => n + m.paths.length, 0) < 8192) {
    const rules = modules.map(m => ({ name: m.name, patterns: m.paths.map(globRegex) }));
    return file => rules.filter(r => r.patterns.some(rx => rx.test(file)));
  }

  const byDirectory = new Map();
  const general = [];
  for (const [index, module] of modules.entries()) {
    for (const glob of module.paths) {
      const literal = glob.replaceAll('\\', '/').split(/[?*]/, 1)[0];
      const directory = literal.slice(0, literal.lastIndexOf('/') + 1);
      const rule = { index, regex: globRegex(glob) };
      // Unicode RegExp /i folding can differ from toLowerCase (e.g. Greek sigma).
      if (directory && /^[\x00-\x7f]+$/.test(directory)) {
        const key = directory.toLowerCase();
        if (!byDirectory.has(key)) byDirectory.set(key, []);
        byDirectory.get(key).push(rule);
      } else {
        general.push(rule);
      }
    }
  }
  return file => {
    const found = new Set();
    function check(rules) {
      for (const { index, regex } of rules) {
        if (!found.has(index) && regex.test(file)) found.add(index);
      }
    }
    check(general);
    const key = file.toLowerCase();
    for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
      const rules = byDirectory.get(key.slice(0, slash + 1));
      if (rules) check(rules);
    }
    return [...found].sort((a, b) => a - b).map(i => modules[i]);
  };
}

function impactPaths(paths) {
  const normalized = paths.map(p => p.replaceAll('\\', '/').replace(/^\.\//, ''));
  return [...new Set(normalized.filter(file => file && !file.startsWith('.bdd/')))].sort(compare);
}

function matchImpact(modules, files) {
  const hits = new Map();
  const unmatched = [];
  const matches = impactMatcher(modules.filter(m => !m.error), files.length);
  for (const file of files) {
    const matching = matches(file);
    if (!matching.length) unmatched.push(file);
    for (const { name } of matching) {
      if (!hits.has(name)) hits.set(name, []);
      hits.get(name).push(file);
    }
  }
  return { modules: [...hits.keys()].sort(compare).map(name => ({ name, files: hits.get(name) })), unmatched };
}

function findImpact(modules, paths) {
  return matchImpact(modules, impactPaths(paths));
}

export function repositoryImpact(repo, paths) {
  const files = impactPaths(paths);
  const modules = files.length ? moduleIndex(repo).modules : [];
  return matchImpact(modules, files);
}

export { moduleIndex, findImpact, nextId, readFeature };
