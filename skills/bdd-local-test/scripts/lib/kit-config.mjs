import fs from 'node:fs';
import path from 'node:path';
import validateConfig from './config-validator.mjs';

function readJson(file) {
  const contents = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Invalid JSON in ' + file);
  }
}

function loadKitConfig(root = process.cwd()) {
  const file = path.resolve(root, '.bdd', 'config.json');
  const config = readJson(file);
  if (!validateConfig(config)) {
    // Report paths and schema messages, never configuration values or credentials.
    const issues = validateConfig.errors.map(error => {
      const field = error.params.additionalProperty ?? error.params.missingProperty;
      const pointer = error.instancePath + (field === undefined ? '' :
        '/' + field.replace(/~/g, '~0').replace(/\//g, '~1'));
      return (pointer || '/') + ': ' + error.message;
    });
    throw new Error('Invalid BDD config in ' + file + '\n' + issues.join('\n') +
      '\nFix the indicated fields using schemas/config.schema.json.');
  }
  return config.kit ?? {};
}

export { readJson, loadKitConfig };
