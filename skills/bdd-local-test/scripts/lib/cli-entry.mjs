import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isCliEntry(meta) {
  if (typeof meta.main === 'boolean') return meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  if (pathToFileURL(entry).href === meta.url) return true;
  try {
    // Older Node versions resolve linked module URLs but leave argv[1] as invoked.
    return pathToFileURL(realpathSync(entry)).href === meta.url;
  } catch {
    // stdin and eval can have an argument that is not a file.
    return false;
  }
}
