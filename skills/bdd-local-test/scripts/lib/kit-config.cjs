'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  const contents = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Invalid JSON in ' + file);
  }
}

function loadKitConfig(root = process.cwd()) {
  return readJson(path.join(root, '.bdd', 'config.json')).kit ?? {};
}

module.exports = { readJson, loadKitConfig };
