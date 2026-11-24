import fs from 'node:fs';
import path from 'node:path';
import { evidenceFolder, isEvidenceImage, maskRecord, readMaskLedger, sha256File } from './mask-ledger.mjs';

export const pathKey = name => process.platform === 'win32' ? name.toLowerCase() : name;

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function below(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// A new output directory can still alias a group through a junction in its parent.
function canonical(file) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })) return fs.realpathSync.native(file);
  if (path.dirname(file) === file) throw new Error('Cannot resolve output path: ' + file);
  return path.join(canonical(path.dirname(file)), path.basename(file));
}

export function checkSeparateDirectories(root, destination) {
  const a = canonical(root);
  const b = canonical(destination);
  if (below(a, b) || below(b, a)) throw new Error('OutputDir must be separate from group outputs.');
}

export function artifact(root, reference, literal = false) {
  const name = literal ? reference : reference?.split('#', 1)[0];
  if (!name || path.win32.isAbsolute(name) || name.includes(':')) throw new Error('Unsafe artifact path: ' + reference);
  let relativeName = name.replaceAll('\\', '/');
  const folder = relativeName.split('/', 1)[0];
  if (folder.toLowerCase() === 'evidence' && !fs.lstatSync(path.join(root, folder), { throwIfNoEntry: false })) {
    const actual = evidenceFolder(root);
    if (actual) relativeName = actual + relativeName.slice(folder.length);
  }
  const file = path.resolve(root, relativeName);
  if (!below(root, file) || file === root) throw new Error('Artifact escapes outputDir: ' + reference);
  const parts = ['', ...path.relative(root, file).split(path.sep)];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new Error('Missing artifact: ' + reference);
    if (stat.isSymbolicLink()) throw new Error('Linked artifact not accepted: ' + reference);
    if (!path.relative(current, file) && !stat.isFile()) throw new Error('Missing artifact: ' + reference);
  }
  return file;
}

// Read the ledger once per group. Hash only screenshots cited as passing evidence.
export function evidenceChecker(root) {
  let ledger;
  const checked = new Set();
  return (reference, passed) => {
    const file = artifact(root, reference);
    if (!passed || !isEvidenceImage(file) || checked.has(file)) return;
    ledger ??= readMaskLedger(root);
    const relative = path.relative(root, file).split(path.sep).join('/');
    const record = maskRecord(ledger, relative);
    if (!/^evidence\//i.test(relative) || typeof record?.sha256 !== 'string' ||
        record.sha256.toUpperCase() !== sha256File(file)) throw new Error('Invalid image masking: ' + reference);
    checked.add(file);
  };
}

// editablePaths uses PowerShell string wildcards: * and ? also match separators,
// [a-z] is a character class, and a backtick quotes the following character.
export function wildcard(pattern, ignoreCase = process.platform === 'win32') {
  const tokens = pattern.match(/\x60[\s\S]|\[(?:\x60[\s\S]|[^\]])+\]|[\s\S]/g) || [];
  const escape = char => char.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const regex = tokens.map(token => {
    if (token === '*') return '[\\s\\S]*';
    if (token === '?') return '[\\s\\S]';
    if (token.length > 1 && token.startsWith('\x60')) return escape(token.slice(1));
    if (token.length > 1) {
      const chars = token.slice(1, -1).match(/\x60[\s\S]|[\s\S]/g);
      return '[' + chars.map(c => c === '-' ? '-' : '\\u' + c.at(-1).charCodeAt(0).toString(16).padStart(4, '0')).join('') + ']';
    }
    return escape(token);
  });
  return new RegExp('^' + regex.join('') + '$', ignoreCase ? 'i' : '');
}

export function checkModifiedPaths(paths, editable) {
  const patterns = editable.map(pattern => wildcard(pattern));
  for (const file of paths) {
    if (path.win32.isAbsolute(file) || file.includes(':') || /(^|[\\/])\.\.([\\/]|$)/.test(file)) {
      throw new Error('Unsafe modified path: ' + file);
    }
    if (!patterns.some(re => re.test(file))) throw new Error('Unauthorized modification: ' + file);
  }
}
