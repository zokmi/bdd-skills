import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { isCliEntry } from './cli-entry.mjs';

async function indexStat(index) {
  try {
    const stat = await lstat(index);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`封存索引不是獨立的一般檔案：${index}`);
    return stat;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

export async function withIndexLock(index, callback) {
  await mkdir(path.dirname(index), { recursive: true });
  const lockPath = index + '.lock';
  const expiration = Date.now() + 5000;
  let lock;
  while (!lock) {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= expiration) throw new Error(`封存索引正由其他程序使用：${lockPath}`);
      await delay(50);
    }
  }
  try {
    return await callback(await indexStat(index));
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function findArchiveIndexRoot(archivePath) {
  let dir = path.dirname(path.resolve(archivePath));
  for (let i = 0; i < 4; i++) {
    if (await indexStat(path.join(dir, 'index.jsonl'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const error = new Error(`找不到封存索引 index.jsonl（從 ${archivePath} 往上 4 層），請以 --archive-root 指定`);
  error.code = 'ENOENT';
  throw error;
}

export function archiveKey(archive) {
  const normalized = path.resolve(archive);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function* indexEvents(index, stat, priorIssue) {
  if (!stat?.size) return;
  const input = createReadStream(index, { encoding: 'utf8', end: stat.size - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let replacement;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line.replace(/^\uFEFF/, ''));
      // publish() appends the creation immediately followed by its automatic
      // replacement statuses in one write. Older writers matched only repo/topic.
      if (replacement && event.event === 'status' && event.status === 'superseded' &&
          event.by === replacement.archive && event.at === replacement.at) {
        const previous = priorIssue(archiveKey(event.archive));
        if (previous && replacement.issue && previous !== replacement.issue) continue;
      } else {
        replacement = event.event === 'created' && typeof event.at === 'string' && event.at ?
          { archive: event.archive, issue: archiveIssue(event), at: event.at } : null;
      }
      yield event;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

const isDigest = value => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value);

export function archiveIssue({ issue, sourceDir, topic }) {
  if (issue != null && issue !== '') return String(issue);
  // A group's leaf carries its role; its parent task directory carries the issue.
  const group = sourceDir?.match(/(?:^|[/\\])\.bdd[/\\](\d+)-[^/\\]+[/\\]groups[/\\][^/\\]+$/i);
  return group?.[1] ?? topic?.match(/^(\d+)-/)?.[1] ?? '';
}

export async function readArchiveStates(index, { archive, includeVerifiedOriginals = false } = {}) {
  const states = new Map();
  const wanted = archive && archiveKey(archive);
  for await (const event of indexEvents(index, await indexStat(index), key => states.get(key)?.issue)) {
    const key = archiveKey(event.archive);
    if (wanted && wanted !== key) continue;
    if (event.event === 'created') {
      states.set(key, {
        archive: event.archive, name: event.name ?? null, issue: archiveIssue(event) || (event.issue ?? null), topic: event.topic ?? null,
        commit: event.commit ?? null, sha256: event.sha256, bytes: event.bytes, repo: event.repo ?? null,
        createdAt: event.at, status: 'local-only', attachments: [], statusAt: event.at,
        legacy: Boolean(event.legacy), recompressed: false, issueCopySha256: null,
        ...(includeVerifiedOriginals && { verifiedOriginalSha256: event.legacy === true ? new Set() : null }),
      });
      continue;
    }
    const state = states.get(key);
    if (!state) continue;
    if (event.event === 'status') {
      state.status = event.status;
      state.statusAt = event.at;
      if (event.attachments?.length) state.attachments = [].concat(event.attachments);
    } else if (event.event === 'recompressed') {
      if (state.verifiedOriginalSha256) {
        const linked = isDigest(event.sha256) && isDigest(event.previousSha256) &&
          event.previousSha256.toUpperCase() === String(state.sha256).toUpperCase();
        if (!linked) state.verifiedOriginalSha256.clear();
        else if (Array.isArray(event.verifiedOriginalSha256) && event.verifiedOriginalSha256.every(isDigest)) {
          for (const hash of event.verifiedOriginalSha256) state.verifiedOriginalSha256.add(hash.toUpperCase());
        }
      }
      state.issueCopySha256 ??= event.previousSha256;
      state.sha256 = event.sha256;
      state.bytes = event.bytes;
      state.recompressed = true;
    }
  }
  const result = [...states.values()];
  if (includeVerifiedOriginals) {
    for (const state of result) state.verifiedOriginalSha256 = Array.from(state.verifiedOriginalSha256 ?? []);
  }
  return result;
}

export async function previousArchives(index, stat, created) {
  const active = new Map();
  const issue = archiveIssue(created);
  for await (const event of indexEvents(index, stat, key => active.has(key) ? issue : null)) {
    const key = archiveKey(event.archive);
    if (event.event === 'created') {
      if (event.topic?.toLowerCase() === created.topic.toLowerCase() && archiveIssue(event) === issue && event.repo &&
          path.relative(event.repo, created.repo) === '' && path.relative(event.archive, created.archive) !== '') {
        active.set(key, { archive: event.archive, status: 'local-only' });
      } else active.delete(key);
    } else if (event.event === 'status' && active.has(key)) {
      active.get(key).status = event.status;
    }
  }
  return [...active.values()].filter(item => item.status !== 'superseded').map(item => item.archive);
}

export async function appendIndexEvents(index, stat, events) {
  const output = await open(index, stat ? 'a+' : 'ax+', 0o600);
  let failed = false;
  try {
    let prefix = '';
    if (stat?.size) {
      const last = Buffer.alloc(1);
      await output.read(last, 0, 1, stat.size - 1);
      if (last[0] !== 10) prefix = '\n';
    }
    const data = Buffer.from(prefix + events.map(event => JSON.stringify(event)).join('\n') + '\n');
    if ((await output.write(data)).bytesWritten !== data.length) throw new Error(`封存索引寫入不完整：${index}`);
    await output.sync();
  } catch (err) {
    failed = true;
    if (stat) await output.truncate(stat.size);
    throw err;
  } finally {
    await output.close();
    if (failed && !stat) await unlink(index);
  }
}

// Keep the PowerShell module's Add-ArchiveIndexEvent entry point on the shared writer lock.
if (isCliEntry(import.meta)) {
  try {
    const index = path.resolve(process.argv[2], 'index.jsonl');
    process.stdin.setEncoding('utf8');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const event = JSON.parse(input.replace(/^\uFEFF/, ''));
    await withIndexLock(index, stat => appendIndexEvents(index, stat, [event]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
