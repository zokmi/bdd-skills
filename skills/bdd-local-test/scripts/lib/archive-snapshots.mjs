import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { byteLimit } from './archive-limits.mjs';

// Resolve every path at the recorded revision, even when several paths claim the same blob.
function checkedBlobs(repo, commit, snapshots) {
  const paths = [...new Set(snapshots.map(s => s.scenarioPath))];
  // The path components have already been validated. Keep revisions on one protocol line too.
  if (/[\r\n\0]/.test(commit)) throw new Error('受測 commit 含無效字元');
  const input = paths.map(name => commit + ':' + name).join('\n') + '\n';
  const result = spawnSync('git', ['-C', repo, 'cat-file', '--batch-check'], {
    input, encoding: 'utf8', windowsHide: true,
    maxBuffer: Buffer.byteLength(input) + paths.length * 100,
  });
  if (result.error) throw result.error;
  const lines = result.stdout.split('\n');
  if (result.status !== 0 || lines.pop() !== '' || lines.length !== paths.length) {
    throw new Error(`無法核對受測 commit ${commit} 的情境版本`);
  }
  const records = new Map(paths.map((name, index) => [name, lines[index]]));
  const blobs = new Map();
  for (const { scenarioPath, blob } of snapshots) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (\d+)$/.exec(records.get(scenarioPath));
    if (!match || match[1] !== blob) {
      throw new Error(`情境檔在受測 commit ${commit} 的版本與紀錄不符：${scenarioPath}`);
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > byteLimit) throw new Error('封存超出還原位元組上限：' + byteLimit);
    blobs.set(blob, size);
  }
  return blobs;
}

// Git frames each response as a header, an exact number of binary bytes and a newline.
// Keep one stdout chunk between responses so a large feature never has to fit in memory.
async function stageBatch(stdout, blobs, staging) {
  const stream = stdout[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function* take(size) {
    while (size) {
      if (!pending.length) {
        const next = await stream.next();
        if (next.done) throw new Error('Git blob 資料提前結束');
        pending = next.value;
      }
      const bytes = pending.subarray(0, size);
      pending = pending.subarray(bytes.length);
      size -= bytes.length;
      yield bytes;
    }
  }
  async function expect(text) {
    const expected = Buffer.from(text);
    let offset = 0;
    for await (const part of take(expected.length)) {
      if (!expected.subarray(offset, offset + part.length).equals(part)) throw new Error('Git blob 批次回應不符');
      offset += part.length;
    }
  }

  const staged = new Map();
  for (const [oid, size] of blobs) {
    await expect(oid + ' blob ' + size + '\n');
    const file = path.join(staging, 'snapshot-' + oid);
    const hash = createHash('sha256');
    async function* payload() {
      for await (const bytes of take(size)) {
        hash.update(bytes);
        yield bytes;
      }
    }
    await writeFile(file, payload(), { flag: 'wx' });
    await expect('\n');
    staged.set(oid, { path: file, size, sha256: hash.digest('hex').toUpperCase(), mtime: (await stat(file)).mtime });
  }
  if (pending.length || !(await stream.next()).done) throw new Error('Git blob 批次回應超出預期');
  return staged;
}

export async function stageSnapshots(repo, commit, snapshots, staging) {
  const blobs = checkedBlobs(repo, commit, snapshots);
  const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const tasks = [stageBatch(child.stdout, blobs, staging), once(child, 'close'),
    pipeline([[...blobs.keys()].join('\n') + '\n'], child.stdin)];
  try {
    const [staged, [status]] = await Promise.all(tasks);
    if (status !== 0) throw new Error('無法取出受測情境的 Git blob');
    return staged;
  } catch (error) {
    child.stdout.destroy();
    child.stdin.destroy();
    child.kill();
    await Promise.allSettled(tasks);
    throw error;
  }
}
