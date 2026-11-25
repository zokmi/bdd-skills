import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { captureEvidence } from '../scripts/lib/evidence-screenshot.mjs';

const cli = fileURLToPath(new URL('../scripts/bdd.mjs', import.meta.url));
const compatibilityCli = fileURLToPath(new URL('../scripts/bdd.cjs', import.meta.url));

for (const entry of [cli, compatibilityCli]) {
  test(`${path.basename(entry)} cli-session reports a blocked preflight in JSON`, () => {
    const result = spawnSync(process.execPath, [entry, 'cli-session'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const { status, error } = JSON.parse(result.stderr);
    assert.equal(status, 'blocked');
    assert.match(error, /<prepared\.json>/);
  });
}

test('standalone ESM commands run through a linked installation directory', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd linked cli-'));
  const link = path.join(parent, 'plugin #1');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.symlinkSync(path.dirname(cli), link, 'junction');
  const commands = [
    ['bdd.mjs', 1], ['route-snippet.mjs', 2], ['probe-cli-route.mjs', 1],
    ['worktree-cli-session.mjs', 1], ['lib/archive-index.mjs', 1],
  ];
  for (const [file, expected] of commands) {
    const result = spawnSync(process.execPath, [path.join(link, file)], { encoding: 'utf8' });
    assert.equal(result.status, expected, file);
    assert.ok(result.stderr.trim(), file);
  }
});

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd cli 測試-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, 'gitignore', '--repo', repo, ...args], { encoding: 'utf8' });
    assert.ok(result.stdout, result.stderr);
    return [result.status, JSON.parse(result.stdout)];
  };
  return { repo, git, run };
}

function screenshotFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd screenshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, '.bdd', 'run', 'evidence');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(root, '.bdd', 'config.json'), JSON.stringify({ mask: { selectors: ['[data-pii]', '.avatar'] } }));
  return { root, output };
}

test('CLI evidence capture applies locator masks and saves only the requested WebP', async t => {
  const { root, output } = screenshotFixture(t);
  const filename = '.bdd/run/evidence/IC-05_結帳.webp';
  const rendered = [];
  const page = {
    locator(selector) {
      return {
        selector,
        count: async () => Number(selector === 'css=[data-pii] >> visible=true'),
        screenshot: async options => {
          assert.equal(selector, 'css=#summary');
          assert.equal(options.type, 'webp');
          assert.equal(options.quality, 100);
          assert.equal(options.scale, 'css');
          assert.equal(options.maskColor, '#000000');
          assert.equal(Array.from(options.mask, loc => loc.selector).join(','), 'css=[data-pii],css=.avatar');
          rendered.push(options.path);
          fs.writeFileSync(options.path, 'RIFF\x00\x00\x00\x00WEBP', 'latin1');
        },
      };
    },
  };
  const session = { run: async (command, code) => {
    assert.equal(command, 'run-code');
    await vm.runInNewContext(`(${code})`)(page);
  } };
  assert.deepEqual(await captureEvidence(session, root, { filename, target: '#summary' }), { filename, type: 'webp' });
  assert.equal(rendered.length, 1);
  assert.deepEqual(fs.readdirSync(output), ['IC-05_結帳.webp']);
  await assert.rejects(captureEvidence(session, root, { filename, target: '#summary' }), /already exists/);
  assert.equal(rendered.length, 1);
});

test('CLI evidence capture leaves no file when masks do not match or capture fails', async t => {
  const { root, output } = screenshotFixture(t);
  const filename = '.bdd/run/evidence/IC-06.png';
  const page = {
    locator: () => ({ count: async () => 0 }),
    screenshot: async () => assert.fail('screenshot taken without a visible mask'),
  };
  const session = { run: async (_, code) => vm.runInNewContext(`(${code})`)(page) };
  await assert.rejects(captureEvidence(session, root, { filename }), /No configured screenshot mask is visible/);
  page.locator = () => ({ count: async () => 1 });
  page.screenshot = async ({ path: stagedPath, type }) => {
    assert.equal(type, 'png');
    fs.writeFileSync(stagedPath, 'partial');
    throw new Error('capture failed');
  };
  await assert.rejects(captureEvidence(session, root, { filename }), /capture failed/);
  assert.deepEqual(fs.readdirSync(output), []);
  assert.deepEqual(fs.readdirSync(path.join(root, '.bdd')).sort(), ['config.json', 'run']);
  await assert.rejects(captureEvidence(session, root, { filename: '.bdd/run/evidence/../outside.png' }), /evidence path/);
});

test('gitignore checks without writing, preserves bytes, and is idempotent', t => {
  const { repo, run } = fixture(t);
  const ignore = path.join(repo, '.gitignore');
  const original = Buffer.from('\uFEFF# 原規則\r\n/local');
  fs.writeFileSync(ignore, original);
  assert.equal(run('--check')[0], 1);
  assert.deepEqual(fs.readFileSync(ignore), original);
  const [status, applied] = run();
  assert.equal(status, 0);
  assert.equal(applied.updated, true);
  assert.deepEqual(fs.readFileSync(ignore).subarray(0, original.length), original);
  assert.equal(run()[1].updated, false);
});

test('gitignore reports tracked output and rolls back a conflicting nested rule', t => {
  const { repo, git, run } = fixture(t);
  const output = path.join(repo, '.bdd/run/REPORT.md');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, '');
  git('add', '-f', '.bdd/run/REPORT.md');
  fs.mkdirSync(path.join(repo, '.bdd/modules'));
  fs.writeFileSync(path.join(repo, '.bdd/modules/.gitignore'), '*.feature\n');
  assert.equal(run()[0], 2);
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);
  fs.unlinkSync(path.join(repo, '.bdd/modules/.gitignore'));
  const [status, result] = run();
  assert.equal(status, 1);
  assert.deepEqual(result.trackedOutputs, ['.bdd/run/REPORT.md']);
});

test('gitignore batches preserve Git negations, rule details, and index ordering across hundreds of paths', t => {
  const { repo, git, run } = fixture(t);
  const dir = path.join(repo, '.bdd', 'run');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 280; i++) fs.writeFileSync(path.join(dir, i + '.txt'), '');
  fs.writeFileSync(path.join(dir, '報告 迴歸.txt'), '');
  fs.writeFileSync(path.join(repo, '.gitignore'), '/.bdd/run/*\n!/.bdd/run/報告 迴歸.txt\n');
  git('add', '-f', '--', '.bdd/run/9.txt', '.bdd/run/11.txt', '.bdd/run/20.txt');
  const [status, result] = run('--check');
  assert.equal(status, 1);
  assert.deepEqual(result.trackedOutputs, ['.bdd/run/11.txt', '.bdd/run/20.txt', '.bdd/run/9.txt']);
  const failures = result.failures.filter(item => item.path.startsWith('.bdd/run/'));
  assert.deepEqual(failures, [{
    path: '.bdd/run/報告 迴歸.txt', expectedIgnored: true, rule: ['.gitignore:2:!/.bdd/run/報告 迴歸.txt\t.bdd/run/報告 迴歸.txt'],
  }]);
});
