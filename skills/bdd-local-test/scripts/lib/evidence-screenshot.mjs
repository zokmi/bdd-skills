import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readJson } from './kit-config.mjs';
import { runPlaywrightCli } from './worktree-cli.mjs';

function validateOptions({ filename, target, fullPage = false, scale = 'css' } = {}) {
  const parts = typeof filename === 'string' ? filename.split('/') : [];
  const type = parts.at(-1)?.match(/\.(png|webp)$/i)?.[1].toLowerCase();
  if (!type || parts.length < 4 || parts[0] !== '.bdd' || parts[1].toLowerCase() === 'modules' ||
      !parts.slice(2, -1).includes('evidence') ||
      parts.some(part => !part || /[. ]$|[\\:*?"<>|\x00-\x1f]/.test(part))) {
    throw new Error('Expected an evidence path under .bdd/<run>/evidence with a .png or .webp extension');
  }
  if (typeof fullPage !== 'boolean' || !['css', 'device'].includes(scale) ||
      (target !== undefined && (typeof target !== 'string' || !target.trim() || fullPage))) {
    throw new Error('Use an optional CSS target or fullPage, and a css or device scale');
  }
  return { filename, type, target, fullPage, scale };
}

function screenshotCode(settings) {
  return `async page => {
    const { selectors, target, fullPage, ...options } = ${JSON.stringify(settings)};
    const css = selector => 'css=' + selector;
    const visible = await Promise.all(selectors.map(selector => page.locator(css(selector) + ' >> visible=true').count()));
    if (!visible.some(Boolean)) throw new Error('No configured screenshot mask is visible');
    options.mask = selectors.map(selector => page.locator(css(selector)));
    options.maskColor = '#000000';
    if (target) await page.locator(css(target)).screenshot(options);
    else await page.screenshot({ ...options, fullPage });
  }`;
}

async function captureEvidence(session, root, args) {
  const { filename, type, target, fullPage, scale } = validateOptions(args);
  const worktree = await fs.realpath(root);
  const destination = path.join(worktree, filename);
  const parent = path.dirname(destination);
  if (path.relative(parent, await fs.realpath(parent))) {
    throw new Error('Screenshot evidence directory must not traverse a link or junction');
  }
  try {
    await fs.lstat(destination);
    throw new Error('Screenshot evidence already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const selectors = readJson(path.join(worktree, '.bdd', 'config.json'))?.mask?.selectors;
  if (!Array.isArray(selectors) || !selectors.length ||
      selectors.some(selector => typeof selector !== 'string' || !selector.trim())) {
    throw new Error('Configure a nonempty mask.selectors array of CSS selectors before taking evidence');
  }

  const staging = await fs.mkdtemp(path.join(worktree, '.bdd', '.screenshot-'));
  const image = path.join(staging, 'capture.' + type);
  try {
    const settings = { selectors, target, fullPage, path: image, type, scale, timeout: 15000 };
    if (type === 'webp') settings.quality = 100;
    await session.run('run-code', screenshotCode(settings));
    try {
      await fs.copyFile(image, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Playwright CLI did not save the screenshot to the worktree');
      if (error.code === 'EEXIST') throw new Error('Screenshot evidence already exists');
      throw error;
    }
    return { filename, type };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function runScreenshotCli(args) {
  const { values } = parseArgs({ args, options: {
    session: { type: 'string' }, filename: { type: 'string' }, target: { type: 'string' },
    'full-page': { type: 'boolean' }, scale: { type: 'string' }, 'cli-path': { type: 'string' },
  } });
  if (!values.session?.trim()) throw new Error('Expected --session with the name of the active browser session');
  const cwd = process.cwd();
  const session = { run: (...argv) => runPlaywrightCli(values.session, argv, { cwd, cliPath: values['cli-path'] }) };
  const result = await captureEvidence(session, cwd, {
    filename: values.filename, target: values.target, fullPage: values['full-page'], scale: values.scale,
  });
  console.log(JSON.stringify(result));
  return 0;
}

export { captureEvidence, runScreenshotCli };
