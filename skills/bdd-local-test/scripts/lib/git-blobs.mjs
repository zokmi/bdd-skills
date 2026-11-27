import { spawnSync } from 'node:child_process';

const batchBytes = 8 * 1024 * 1024;
// The existing single-blob Git reader accepts up to 64 MiB per Feature.
const maxBlobBytes = 64 * 1024 * 1024;

function* readBatch(repo, entries, outputBytes) {
  const result = spawnSync('git', ['-C', repo, '--no-optional-locks', 'cat-file', '--batch'], {
    input: entries.map(entry => entry.oid).join('\n') + '\n', windowsHide: true,
    maxBuffer: Math.max(outputBytes, 64 * 1024),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8').trim() || 'git cat-file --batch failed');

  const output = result.stdout;
  if (output.length !== outputBytes) throw new Error('Unexpected git cat-file batch length');
  let offset = 0;
  for (const { oid, size, header } of entries) {
    const start = offset + header.length;
    const end = start + size;
    if (output.toString('ascii', offset, start) !== header || output[end] !== 10) {
      throw new Error('Invalid git cat-file batch response for ' + oid);
    }
    yield { oid, bytes: output.subarray(start, end) };
    offset = end + 1;
  }
}

// Sizes come from ls-tree -l, so the common path needs one Git process and
// large groups never share an unbounded stdout buffer.
export function* readGitBlobs(repo, entries) {
  let batch = [], outputBytes = 0;
  for (const { oid, size } of entries) {
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(oid) || !Number.isSafeInteger(size) || size < 0 || size > maxBlobBytes) {
      throw new Error('Invalid or oversized Git blob: ' + oid + ' (' + size + ' bytes)');
    }
    const header = oid + ' blob ' + size + '\n';
    const frameBytes = header.length + size + 1;
    if (batch.length && outputBytes + frameBytes > batchBytes) {
      yield* readBatch(repo, batch, outputBytes);
      batch = [];
      outputBytes = 0;
    }
    batch.push({ oid, size, header });
    outputBytes += frameBytes;
  }
  if (batch.length) yield* readBatch(repo, batch, outputBytes);
}
