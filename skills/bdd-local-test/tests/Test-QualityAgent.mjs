import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  version: { type: 'string', default: 'candidate' },
  strategy: { type: 'string', default: 'Autonomous' },
  'inject-failure': { type: 'boolean' },
} });
const { version, strategy } = values;
if (!['baseline', 'candidate'].includes(version) || !['Fixed', 'Autonomous'].includes(strategy)) {
  throw new Error('Expected --version baseline|candidate and --strategy Fixed|Autonomous');
}

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const bench = fileURLToPath(new URL('Test-QualityBenchmark.mjs', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'bdd-agent-'));
try {
  const settings = join(fixture, '.claude');
  mkdirSync(settings);
  const skill = join(fixture, 'SKILL.md');
  const mode = version === 'baseline' ? 'separate' : 'batch';
  if (version === 'baseline') {
    writeFileSync(skill, execFileSync('git', ['show', '7ff5d82:skills/bdd-local-test/SKILL.md'], { cwd: repo }));
  } else {
    copyFileSync(join(repo, 'skills/bdd-local-test/SKILL.md'), skill);
  }

  const selection = strategy === 'Fixed' ? `Use the fixed strategy ${mode}.` :
    'Choose separate unless the Skill explicitly calls for batching compatible operations while retaining individual assertions, in which case choose batch.';
  const skillContext = version === 'candidate' ? 'Apply this preloaded Skill entry:\n' + readFileSync(skill, 'utf8') : 'Read the Skill at ' + skill + '.';
  const fault = values['inject-failure'];
  const command = `node "${bench}" <chosen mode>${fault ? ' wrong-state' : ''}`;
  const context = [
    `BDD completion hook ${version}. ${skillContext}`, 'The isolated synthetic fixture database is authorized.', selection,
    `Execute the single command ${command} with no suffix, pipes or other commands.`,
    'Do not inspect the benchmark script. Return only its measured JSON result.',
    ...(fault ? ['Run the command exactly once. A nonzero exit is final evidence. Never retry or repair the fixture.'] : []),
  ].join(' ');
  const hook = join(fixture, 'hook.mjs');
  const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } });
  writeFileSync(hook, `process.stdin.resume();\nprocess.stdin.on('end', () => console.log(${JSON.stringify(payload)}));\n`);
  writeFileSync(join(settings, 'settings.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${hook}"` }] }],
  } }));

  const output = execFileSync('claude', ['-p', '--verbose', '--output-format', 'stream-json', '--no-session-persistence',
    '--setting-sources', 'project', '--strict-mcp-config', '--allowedTools', 'Read', 'Bash(node *)', 'PowerShell(node *)',
    '--add-dir', fixture], {
    cwd: fixture, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    input: 'The isolated BDD task is complete. Follow the fixture instructions injected by the hook and report its result.\n',
  });
  const events = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const result = events.filter(e => e.type === 'result').at(-1);
  const evidence = [];
  for (const event of events) {
    for (const item of event.message?.content ?? []) {
      if (item.type !== 'tool_result' || typeof item.content !== 'string') continue;
      for (const line of item.content.split(/\r?\n/)) {
        if (line.startsWith('{"mode":')) evidence.push(JSON.parse(line));
      }
    }
  }
  if (!result || result.is_error || result.permission_denials?.length || evidence.length !== 1 ||
      ((strategy === 'Fixed' || version === 'candidate') && evidence[0].mode !== mode) ||
      evidence[0].status !== (fault ? 'FAILED' : 'PASSED')) {
    throw new Error('Unexpected benchmark evidence: ' + JSON.stringify({ evidence, result }));
  }
  console.log(JSON.stringify({ version, strategy, fixture: evidence[0], agentMs: result.duration_ms, usage: result.usage }));
} finally {
  rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
}
