import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { optimizeImages } from '../scripts/lib/archive-images.mjs';
import { deduplicate, fileEntry, hashBytes } from '../scripts/lib/archive-pack.mjs';
import { parseMaskLedger } from '../scripts/lib/mask-ledger.mjs';

const helper = fileURLToPath(new URL('../scripts/lib/bdd_webp.py', import.meta.url));

async function temp(t) {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'bdd-test-images-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

test('archive batches conversions, reuses validated images by content and format, and retains failed originals', async t => {
  const dir = await temp(t);
  const worker = path.join(dir, 'worker.cjs');
  const log = path.join(dir, 'worker.log');
  await writeFile(worker, [
    "const fs = require('node:fs');",
    "const log = process.argv[2];",
    "fs.appendFileSync(log, 'start\\n');",
    "require('node:readline').createInterface({input:process.stdin}).on('line', line => {",
    "  const {source, destination} = JSON.parse(line);",
    "  const input = fs.readFileSync(source);",
    "  const type = input.toString().trim();",
    "  fs.appendFileSync(log, type + require('node:path').extname(source) + '\\n');",
    "  if (type === 'error' || source.endsWith('.jpg')) return console.log(JSON.stringify({error:'invalid image'}));",
    "  fs.writeFileSync(destination, type === 'larger' ? Buffer.alloc(input.length + 1) : Buffer.from([1,2]));",
    "  console.log(JSON.stringify({identical:type !== 'different'}));",
    "});",
  ].join('\n'));
  const previous = process.env.BDD_WEBP_ENCODER;
  process.env.BDD_WEBP_ENCODER = 'pillow';
  const nativeSpawn = childProcess.spawn;
  const probe = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: '{"ok":true}' }));
  const spawn = t.mock.method(childProcess, 'spawn', (_command, args, opts) => {
    assert.equal(args.at(-1), 'batch');
    return nativeSpawn(process.execPath, [worker, log], opts);
  });
  syncBuiltinESMExports();
  try {
    const entries = [];
    const inputFiles = [
      ['alias.png', 'valid'], ['b.jpg', 'valid'], ['c.png', 'error'], ['d.png', 'larger'],
      ['e.png', 'different'], ['other.png', 'valid'], ['taken.png', 'ignored'], ['taken.webp', 'existing'],
    ];
    for (const [name, value] of inputFiles) {
      const source = path.join(dir, name);
      await writeFile(source, value);
      entries.push(await fileEntry('evidence/' + name, source, { note: name }));
    }
    const ledger = parseMaskLedger('{}'), warnings = [];
    const { webp } = await optimizeImages(entries, ledger, 'auto', dir, warnings);
    assert.equal(webp.encoder, 'pillow');
    assert.equal(webp.converted, 2);
    assert.deepEqual(webp.skipped.map(({ reason }) => reason),
      ['encoder-failed', 'encoder-failed', 'not-smaller', 'not-identical', 'name-conflict']);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
      'start', 'valid.png', 'valid.jpg', 'error.png', 'larger.png', 'different.png',
    ]);
    const plan = deduplicate(entries);
    assert.equal(plan.aliases['evidence/other.webp'], 'evidence/alias.webp');
    const first = plan.files['evidence/alias.webp'];
    assert.equal(first.note, 'alias.png');
    assert.equal(first.size, 2);
    assert.equal(first.sha256, hashBytes(Buffer.from([1, 2])));
    assert.equal(first.originalName, 'evidence/alias.png');
    assert.equal(first.originalSha256, hashBytes(Buffer.from('valid')));
    for (const [name, value] of inputFiles) assert.equal(await readFile(path.join(dir, name), 'utf8'), value);
  } finally {
    spawn.mock.restore();
    probe.mock.restore();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.BDD_WEBP_ENCODER;
    else process.env.BDD_WEBP_ENCODER = previous;
  }
});

test('Pillow keeps transparent RGB exact and rejects unsupported depths, oversized and multi-frame inputs', async t => {
  const python = [['python'], ['python3'], ['py', '-3']].find(([cmd, ...args]) => {
    const probe = childProcess.spawnSync(cmd, [...args, helper, 'check'], { encoding: 'utf8', windowsHide: true });
    return probe.status === 0 && JSON.parse(probe.stdout).ok;
  });
  if (!python) return t.skip('Requires Python with Pillow WebP support');
  const dir = await temp(t);
  const check = childProcess.spawnSync(python[0], [...python.slice(1), '-c', [
    'import pathlib, runpy, sys',
    'from PIL import Image',
    'helper, folder = sys.argv[1], pathlib.Path(sys.argv[2])',
    'codec = runpy.run_path(helper)',
    'with Image.new("RGBA", (1024,513)) as a, a.copy() as b:',
    '    assert codec["_same_rgba"](a,b)',
    '    b.putpixel((1023,512), (1,2,3,0))',
    '    assert not codec["_same_rgba"](a,b)',
    'files = [("gif","GIF",Image.new("P",(8,8)),{}, "cannot identify"),',
    '         ("large","PNG",Image.new("1",(10000,4000)),{}, "pixel limit"),',
    '         ("animated","PNG",Image.new("RGB",(8,8)),dict(save_all=True,append_images=[Image.new("RGB",(8,8),"white")]),"single-frame"),',
    '         ("16bit","PNG",Image.new("I;16",(64,64),1000),{}, "bit depth")]',
    'for name, fmt, image, options, message in files:',
    '    source, dest = folder / (name + ".png"), folder / (name + ".webp")',
    '    image.save(source, format=fmt, **options)',
    '    original = source.read_bytes()',
    '    try: codec["convert"](str(source), str(dest))',
    '    except (ValueError, OSError) as error: assert message in str(error), error',
    '    else: raise AssertionError(name + " accepted")',
    '    assert source.read_bytes() == original and not dest.exists()',
    'src, dst = folder / "列表 首頁.png", folder / "列表 首頁.webp"',
    'with Image.new("RGBA", (200,100), (51,102,153,255)) as image:',
    '    image.putpixel((3,3),(10,20,30,0))',
    '    image.save(src)',
    'result = codec["convert"](str(src),str(dst))',
    'assert result["identical"] and result["webpBytes"] < result["sourceBytes"]',
  ].join('\n'), helper, dir], { encoding: 'utf8', windowsHide: true });
  assert.equal(check.status, 0, check.stderr);
});
