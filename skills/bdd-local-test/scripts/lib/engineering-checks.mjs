import path from 'node:path';
import { engineeringChecks } from './parallel-validators.mjs';

export function hasEngineeringCoverage(round) {
  const { engineeringChecks: ids, engineeringSources: sources, files, fileModes } = round;
  if (ids === undefined && sources === undefined) return true;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      !Array.isArray(sources) || sources.length !== ids.length || !files || !fileModes) return false;
  return sources.every((source, index) => typeof source?.id === 'string' && source.id && source.id === ids[index] &&
    typeof source.path === 'string' && source.path && Object.hasOwn(files, source.path) && Object.hasOwn(fileModes, source.path));
}

export function validateEngineeringChecks(checks, paths) {
  if (!engineeringChecks(checks)) {
    const error = engineeringChecks.errors[0];
    throw new Error('Invalid engineering checks: ' + (error.instancePath || '/') + ' ' + error.message);
  }
  if (!Array.isArray(paths)) throw new Error('Engineering checks require explicit batch paths');
  const changed = new Set(paths);
  const ids = new Set();
  for (const check of checks) {
    if (check.id !== check.id.trim() || /[\r\n]/.test(check.id) || ids.has(check.id)) {
      throw new Error('Invalid or duplicate engineering check ID: ' + check.id);
    }
    ids.add(check.id);
    if (!changed.has(check.path) || path.win32.isAbsolute(check.path) || check.path.includes('\\') ||
        check.path.split('/').some(part => !part || part === '.' || part === '..') || /\.feature$/i.test(check.path)) {
      throw new Error('Engineering check must reference a changed non-Feature path in this batch: ' + check.path);
    }
  }
  return checks;
}
