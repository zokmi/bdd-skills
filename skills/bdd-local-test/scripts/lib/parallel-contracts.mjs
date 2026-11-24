import { readFileSync } from 'node:fs';
import { assignment, result } from './parallel-validators.mjs';

const validators = new Map([['assignment', assignment], ['result', result]]);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function readContract(file, kind) {
  const validate = validators.get(kind);
  if (!validate) throw new TypeError('Unknown parallel BDD contract: ' + kind);

  const bytes = readFileSync(file);
  let record;
  try {
    record = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new Error('Invalid JSON in ' + file);
  }
  if (!validate(record)) {
    const error = validate.errors[0];
    throw new Error('Invalid ' + kind + ' schema: ' + file + ' (' + (error.instancePath || '/') + ' ' + error.message + ')');
  }
  return record;
}
