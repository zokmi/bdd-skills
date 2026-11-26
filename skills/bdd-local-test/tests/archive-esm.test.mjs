import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { repository, resolveArchiveRoot } from '../scripts/lib/archive-store.mjs';
import { expandArchive } from '../scripts/lib/extract.mjs';
import { openZip, writeZip } from '../scripts/lib/zip-io.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const bluePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAN0lEQVR4nO3RMQ0AMAzEQLf8OacQ3CWbD8BHcg4Mm+7qOh340A9UiVSJVIlUiVSJVIlUiVSJVIlUiVSJMA+hxgE/8m7SpQAAAABJRU5ErkJggg==', 'base64');

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdd-native-archive-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const dir = path.join(repo, '.bdd', '123-中文');
  const root = path.join(base, 'store');
  const evidence = path.join(dir, 'evidence');
  await mkdir(evidence, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  const scenario = '.bdd/modules/reports/01.feature';
  await mkdir(path.dirname(path.join(repo, scenario)), { recursive: true });
  const feature = Buffer.from('Feature: 訂單匯出\n');
  await writeFile(path.join(repo, scenario), feature);
  git(repo, 'add', '--', scenario);
  git(repo, '-c', 'user.name=bdd-test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  const head = git(repo, 'rev-parse', 'HEAD');
  const blob = git(repo, 'rev-parse', 'HEAD:' + scenario);
  await writeFile(path.join(repo, scenario), 'working tree has diverged');
  await writeFile(path.join(dir, 'verification.json'), JSON.stringify({ rounds: [{ head, scenarios: [{ path: scenario, blob, role: 'changed' }] }] }));
  await writeFile(path.join(dir, 'REPORT.md'), '報告');
  await writeFile(path.join(evidence, '輪次.txt'), 'same evidence');
  await writeFile(path.join(evidence, '輪次-2.txt'), 'same evidence');
  const command = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, 'archive', '--dir', dir, '--archive-root', root, ...args],
      { windowsHide: true, env: { ...process.env, BDD_WEBP_ENCODER: 'none' } });
    return JSON.parse(stdout);
  };
  return { base, repo, dir, root, evidence, feature, head, command };
}

test('CLI snapshots the committed Git blob and restores logical duplicates from the verified archive', async t => {
  const f = await fixture(t);
  const r = await f.command();
  assert.equal(r.commit, f.head);
  assert.equal(r.aliasCount, 1);
  assert.equal(r.webpEncoder, null);
  assert.equal(r.sha256, createHash('sha256').update(await readFile(r.archive)).digest('hex').toUpperCase());
  const to = path.join(f.base, 'restored');
  await exec(process.execPath, [cli, 'extract', '--archive', r.archive, '--to', to], { windowsHide: true });
  const folder = path.join(to, path.basename(f.dir));
  assert.deepEqual(await readFile(path.join(folder, 'features/reports/01.feature')), f.feature);
  for (const name of ['輪次.txt', '輪次-2.txt']) {
    assert.equal(await readFile(path.join(folder, 'evidence', name), 'utf8'), 'same evidence');
  }
});

test('concurrent archives preserve both index events and supersede exactly one predecessor', async t => {
  const f = await fixture(t);
  const items = await Promise.all(['one', 'two'].map(name => f.command('--destination', path.join(f.root, name + '.zip'))));
  const events = (await readFile(items[0].index, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.event), ['created', 'created', 'status']);
  assert.equal(events[2].archive, events[0].archive);
  assert.equal(events[2].by, events[1].archive);
  assert.deepEqual(items.flatMap(i => i.superseded), [events[0].archive]);
  assert.deepEqual((await readdir(f.root)).sort(), ['index.jsonl', 'one.zip', 'two.zip']);
});

test('archive and recompress validate matching image bytes by extension before writing ZIP aliases', async t => {
  const helper = fileURLToPath(new URL('../scripts/lib/bdd_webp.py', import.meta.url));
  const pillow = [['python'], ['python3'], ['py', '-3']].some(([exe, ...args]) => {
    const probe = spawnSync(exe, [...args, helper, 'check'], { encoding: 'utf8', windowsHide: true });
    return probe.status === 0 && JSON.parse(probe.stdout).ok;
  });
  if (!pillow) return t.skip('Requires Python with Pillow WebP support');
  const f = await fixture(t);
  const second = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGOs1nVmIAUwkaSaYVQDcYCJSHVwMKqBGEByKAEAAk8BC72JhXYAAAAASUVORK5CYII=', 'base64');
  const samples = { 'a-wrong.jpg': bluePng, 'b-first.png': bluePng, 'c-second.png': second, 'd-first-copy.png': bluePng, 'z-wrong.jpg': second };
  for (const [name, bytes] of Object.entries(samples)) await writeFile(path.join(f.evidence, name), bytes);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], {
    windowsHide: true, env: { ...process.env, BDD_WEBP_ENCODER: 'pillow' },
  })).stdout);
  await run('mask-evidence', '--dir', f.dir, '--mark', '--method', 'exempt', '--note', 'synthetic images');
  for (const operation of ['archive', 'recompress']) {
    await t.test(operation, async () => {
      const archive = path.join(f.root, operation + '.zip');
      if (operation === 'archive') {
        await run('archive', '--dir', f.dir, '--archive-root', f.root, '--destination', archive);
      } else {
        await f.command('--destination', archive); // Original ZIP deduplicates the PNG and JPEG names before conversion.
        const original = await expandArchive({ archive, to: path.join(f.base, 'original') });
        assert.equal(original.manifest.aliases['evidence/b-first.png'], 'evidence/a-wrong.jpg');
        assert.equal(original.manifest.aliases['evidence/z-wrong.jpg'], 'evidence/c-second.png');
        assert.equal((await run('recompress', '--archive', archive)).changed, true);
      }
      const { manifest, folder } = await expandArchive({ archive, to: path.join(f.base, 'restore-' + operation) });
      assert.equal(manifest.webp.encoder, 'pillow');
      assert.equal(manifest.webp.converted, 3);
      assert.deepEqual(manifest.webp.skipped, ['a-wrong.jpg', 'z-wrong.jpg'].map(name => ({ file: 'evidence/' + name, reason: 'encoder-failed' })));
      for (const [name, original] of Object.entries(samples)) {
        const saved = 'evidence/' + name.replace(/\.png$/, '.webp');
        const bytes = await readFile(path.join(folder, saved));
        const record = manifest.files[saved];
        assert.equal(record.sha256, sha(bytes));
        if (name.endsWith('.jpg')) {
          assert.equal(record.sha256, sha(original));
          assert.deepEqual(bytes, original);
        } else {
          assert.equal(record.originalName, 'evidence/' + name);
          assert.equal(record.originalSha256, sha(original));
          assert.equal(record.lossless, true);
          assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
        }
      }
      assert.equal(manifest.aliases['evidence/d-first-copy.webp'], 'evidence/b-first.webp');
      const zip = await openZip(archive);
      try {
        const physical = zip.entries.map(entry => entry.name).filter(name => /\.(jpg|png|webp)$/.test(name)).map(name => path.posix.basename(name));
        assert.deepEqual(physical.sort(), ['a-wrong.jpg', 'b-first.webp', 'c-second.webp', 'z-wrong.jpg']);
      } finally { await zip.close(); }
    });
  }
});

test('archiving the same group for different issues keeps each issue independently active', async t => {
  const f = await fixture(t);
  const archive = async (issue, label, ...args) => {
    const source = path.join(f.repo, '.bdd', issue + '-topic', 'groups', 'api');
    await mkdir(source, { recursive: true });
    for (const name of ['REPORT.md', 'verification.json', 'evidence']) {
      await cp(path.join(f.dir, name), path.join(source, name), { recursive: true });
    }
    return JSON.parse((await exec(process.execPath, [cli, 'archive', '--dir', source, '--archive-root', f.root,
      '--destination', path.join(f.root, label + '.zip'), ...args])).stdout);
  };
  const first = await archive('101', 'first', '--issue', '101');
  const other = await archive('202', 'other', '--issue', '202');
  assert.deepEqual(other.superseded, []);
  // Earlier group archives could have an empty issue, but kept the original source directory.
  const events = (await readFile(first.index, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  events[0].issue = '';
  await writeFile(first.index, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const next = await archive('101', 'next');
  assert.deepEqual(next.superseded, [first.archive]);
  const published = (await readFile(first.index, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(published.find(event => event.archive === next.archive && event.event === 'created').issue, '101');
});

test('restored parallel results retain usable masked evidence after WebP conversion', async t => {
  const f = await fixture(t);
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: f.repo })).stdout);
  const guide = await readFile(new URL('../references/parallel-bdd-contract.md', import.meta.url), 'utf8');
  const [assignment, result] = Array.from(guide.matchAll(/^\x60{3}json\r?\n([\s\S]*?)\r?\n\x60{3}/gm), m => JSON.parse(m[1]));
  const feature = '.bdd/modules/reports/01.feature';
  for (const s of [assignment.scenarios[0], result.scenarios[0]]) s.feature = feature;
  await writeFile(path.join(f.repo, feature), 'Feature: Report\n@' + assignment.scenarios[0].id + '\nScenario: View report\n');
  git(f.repo, '-c', 'user.name=bdd-test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'report scenario', '--', feature);
  const head = git(f.repo, 'rev-parse', 'HEAD');
  Object.assign(assignment.target, { repo: f.repo, workDir: f.repo, head });
  assignment.outputDir = f.dir;
  await run('verification', '--dir', f.dir, '--record', '--commits', head,
    '--changed-scenarios', feature + '::' + assignment.scenarios[0].id, '--passed', '1');
  result.verification.roundIndex = 1;
  const recordedPath = 'evidence/原圖.png';
  result.scenarios[0].evidence = [recordedPath];
  result.scenarios[0].actual = 'Observed ' + recordedPath;
  await writeFile(path.join(f.dir, recordedPath), bluePng);
  await run('mask-evidence', '--dir', f.dir, '--mark', '--pattern', '原圖.png', '--method', 'exempt', '--note', 'Solid blue fixture');
  const attempt = path.join(f.dir, 'coordination', 'attempt-1');
  await mkdir(attempt, { recursive: true });
  const assignmentFile = path.join(attempt, 'assignment.json');
  const resultFile = path.join(attempt, 'result.json');
  await writeFile(assignmentFile, JSON.stringify(assignment));
  await writeFile(resultFile, JSON.stringify(result));
  const zip = await run('archive', '--dir', f.dir, '--archive-root', f.root, '--destination', path.join(f.root, 'converted.zip'));
  if (!zip.webpEncoder) return t.skip('Requires Python with Pillow WebP support');
  assert.equal(zip.webpConverted, 1);
  await rename(f.dir, path.join(f.base, 'before-extraction'));
  await run('extract', '--archive', zip.archive, '--to', path.dirname(f.dir));
  const restored = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.deepEqual(restored.scenarios[0].evidence, ['evidence/原圖.webp']);
  assert.equal(restored.scenarios[0].actual, result.scenarios[0].actual);
  const summary = name => run('parallel-summary', '--assignment', assignmentFile, '--output-dir', path.join(f.base, name));
  assert.equal((await summary('restored')).eligibleForReview, true);
  const existingWebp = await f.command('--destination', path.join(f.root, 'webp-only.zip'));
  assert.equal(existingWebp.webpEncoder, null);
  assert.doesNotMatch(existingWebp.warnings.join(' '), /webpUnavailable/);
  await writeFile(path.join(f.evidence, 'next.png'), bluePng);
  await run('mask-evidence', '--dir', f.dir, '--mark', '--pattern', 'next.png', '--method', 'css');
  const next = await run('archive', '--dir', f.dir, '--archive-root', f.root, '--destination', path.join(f.root, 'next.zip'));
  assert.equal(next.masked, true);
  assert.equal(next.webpConverted, 1);
  const validated = await expandArchive({ archive: next.archive, to: path.join(f.base, 'next-round') });
  assert.equal(validated.manifest.aliases['evidence/原圖.webp'], 'evidence/next.webp');
  // Older converted archives kept the original path in the result and the mapping in masking.json.
  await writeFile(resultFile, JSON.stringify(result));
  assert.equal((await summary('historical')).eligibleForReview, true);
  const ledgerFile = path.join(f.dir, 'masking.json');
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
  const webpRecord = ledger.files['evidence/原圖.webp'];
  webpRecord.derivedFrom.name = 'evidence/unrelated.png';
  await writeFile(ledgerFile, JSON.stringify(ledger));
  const issue = pattern => err => JSON.parse(err.stdout).issues.some(s => pattern.test(s));
  await assert.rejects(summary('wrong-source'), issue(/Missing artifact/));
  webpRecord.derivedFrom.name = recordedPath;
  await writeFile(ledgerFile, JSON.stringify(ledger));
  await writeFile(path.join(f.evidence, '原圖.webp'), 'changed bytes');
  await assert.rejects(summary('changed'), issue(/Invalid image masking/));
});

test('a malformed index or unfinished mask operation leaves the archive unpublished', async t => {
  const f = await fixture(t);
  await mkdir(f.root);
  const index = path.join(f.root, 'index.jsonl');
  const archive = path.join(f.root, 'test.zip');
  await writeFile(index, 'bad index');
  await assert.rejects(f.command('--destination', archive));
  assert.deepEqual(await readdir(f.root), ['index.jsonl']);
  assert.equal(await readFile(index, 'utf8'), 'bad index');
  await writeFile(path.join(f.dir, 'masking.json.lock'), 'pending');
  await assert.rejects(f.command('--destination', archive), /稍後重試/);
  assert.deepEqual(await readdir(f.root), ['index.jsonl']);
});

test('archive honors root precedence, rejects every worktree and preserves existing destinations', async t => {
  const f = await fixture(t);
  const secondary = path.join(f.base, 'other-checkout');
  git(f.repo, 'worktree', 'add', '--quiet', '--detach', secondary);
  const missing = path.join(secondary, '.bdd/missing/nested');
  const { repo, worktrees } = repository(missing);
  assert.equal(repo, secondary);
  assert.deepEqual(worktrees, [f.repo, secondary]);
  const configRoot = path.join(f.base, 'from-config');
  const envRoot = path.join(f.base, 'from-env');
  const inherited = process.env.BDD_ARCHIVE_ROOT;
  t.after(() => {
    if (inherited === undefined) delete process.env.BDD_ARCHIVE_ROOT;
    else process.env.BDD_ARCHIVE_ROOT = inherited;
  });
  delete process.env.BDD_ARCHIVE_ROOT;
  assert.equal(resolveArchiveRoot({ worktrees, outputDir: missing }).root, path.join(os.homedir(), 'bdd-archives', path.basename(f.repo)));
  const settings = { config: { archiveRoot: configRoot } };
  assert.equal(resolveArchiveRoot({ settings, worktrees }).root, configRoot);
  process.env.BDD_ARCHIVE_ROOT = envRoot;
  assert.equal(resolveArchiveRoot({ settings, worktrees }).root, envRoot);
  assert.equal(resolveArchiveRoot({ archiveRoot: f.root, settings, worktrees }).root, f.root);
  for (const tree of worktrees) {
    await assert.rejects(f.command('--destination', path.join(tree, 'sub/archive.zip')), /worktree/);
  }
  const dest = path.join(f.root, 'existing.zip');
  await mkdir(f.root, { recursive: true });
  await writeFile(dest, 'preserve');
  await assert.rejects(f.command('--destination', dest), /已存在/);
  assert.equal(await readFile(dest, 'utf8'), 'preserve');
});

test('archive validates masking, encoder settings and explicit exceptions before publication', async t => {
  const f = await fixture(t);
  const image = 'evidence/chart.png', imagePath = path.join(f.dir, image);
  const settings = path.join(f.repo, '.bdd/config.json');
  await writeFile(imagePath, 'original');
  await assert.rejects(f.command(), /遮罩/);
  await exec(process.execPath, [cli, 'mask-evidence', '--dir', f.dir, '--mark', '--pattern', '*.png', '--method', 'exempt', '--note', 'synthetic chart']);
  await writeFile(imagePath, 'changed');
  await assert.rejects(f.command(), /遮罩/);
  await assert.rejects(f.command('--allow-unmasked-reason', ' '), /理由/);
  assert.deepEqual(await readdir(f.base), ['repo']);
  const unmasked = await f.command('--allow-unmasked-reason', 'local review');
  const restored = await expandArchive({ archive: unmasked.archive, to: path.join(f.base, 'restored') });
  assert.equal(restored.manifest.unmaskedReason, 'local review');
  assert.deepEqual(restored.manifest.unmasked, [image]);
  assert.match(unmasked.warnings.join('\n'), /webpUnavailable/);
  assert.match(path.basename(unmasked.archive), new RegExp('123-.*-' + f.head.slice(0, 7) + '-'));
  await writeFile(settings, JSON.stringify({ mask: { required: false }, webp: 'off', maxAttachmentBytes: 10 }));
  const off = await f.command('--destination', path.join(f.root, 'off.zip'));
  assert.equal(off.masked, false);
  assert.equal(off.exceedsAttachmentLimit, true);
  assert.match(off.warnings.join('\n'), /未登記遮罩/);
  assert.doesNotMatch(off.warnings.join('\n'), /webpUnavailable/);
  await writeFile(settings, JSON.stringify({ webp: 'wrong' }));
  await assert.rejects(f.command(), /webp/);
});

test('archive snapshots checked versioned features once and supports historical issue-local features', async t => {
  const f = await fixture(t);
  const record = path.join(f.dir, 'verification.json');
  const doc = JSON.parse(await readFile(record));
  const [scenario] = doc.rounds[0].scenarios;
  const save = scenarios => writeFile(record, JSON.stringify({ rounds: [{ head: f.head, scenarios }] }));
  for (const [blob, error] of [[null, /尚未提交/], ['0'.repeat(40), /不符/]]) {
    await save([{ ...scenario, blob }]);
    await assert.rejects(f.command(), error);
  }
  await save([scenario, { ...scenario, role: 'regression' }]);
  const saved = await f.command();
  const r = await expandArchive({ archive: saved.archive, to: path.join(f.base, 'snapshots') });
  assert.deepEqual(await readdir(path.join(r.folder, 'features/reports')), ['01.feature']);
  await save([]);
  await assert.rejects(f.command(), /情境/);
  await writeFile(path.join(f.dir, 'scenario.feature'), 'Feature: historical');
  const old = await f.command('--destination', path.join(f.root, 'historical.zip'));
  const restored = await expandArchive({ archive: old.archive, to: path.join(f.base, 'old') });
  assert.deepEqual(restored.manifest.features, []);
  assert.equal(await readFile(path.join(restored.folder, 'scenario.feature'), 'utf8'), 'Feature: historical');
  await rm(record);
  await assert.rejects(f.command(), /verification\.json/);
});

test('archive flattens evidence.zip without replacing loose files that have different content', async t => {
  const f = await fixture(t);
  const legacy = path.join(f.dir, 'evidence.zip');
  const name = 'legacy.txt', data = Buffer.from('old evidence');
  await writeZip(legacy, [{ name, data }]);
  const loose = path.join(f.evidence, name);
  await writeFile(loose, 'other');
  await assert.rejects(f.command(), /不同|覆蓋/);
  assert.equal(await readFile(loose, 'utf8'), 'other');
  await writeFile(loose, data);
  const saved = await f.command();
  const restored = await expandArchive({ archive: saved.archive, to: path.join(f.base, 'restored') });
  assert.deepEqual(restored.manifest.flattenedFrom, ['evidence.zip']);
  assert.equal(Object.hasOwn(restored.manifest.files, 'evidence.zip'), false);
  assert.deepEqual(await readFile(path.join(restored.folder, 'evidence', name)), data);
});
