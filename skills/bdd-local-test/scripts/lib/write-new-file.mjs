import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeNewFile(file, content, mode = 0o666) {
  const staged = path.join(path.dirname(file), '.bdd-tmp-' + randomUUID());
  const fd = fs.openSync(staged, 'wx', mode);
  try {
    try { fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
    // Publish complete contents without replacing a destination won by another writer.
    fs.linkSync(staged, file);
  } finally { fs.unlinkSync(staged); }
}
