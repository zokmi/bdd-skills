// Internal skill entry point. Commands preserve the JSON/JSONL used by the skill.
const { parseArgs } = require('node:util');
const { ensureGitignore } = require('./lib/gitignore.cjs');

async function main([command, ...args]) {
  switch (command) {
    case 'gitignore': {
      const { values } = parseArgs({
        args,
        options: { repo: { type: 'string', default: '.' }, check: { type: 'boolean' } },
      });
      const result = ensureGitignore(values.repo, values.check);
      console.log(JSON.stringify(result));
      return result.failures.length || result.trackedOutputs.length ? 1 : 0;
    }
    case 'mcp-session':
      await require('./worktree-mcp-session.cjs').main(args);
      return 0;
    case 'mcp-probe':
      await require('./probe-mcp-route.cjs').main(args);
      return 0;
    default:
      throw new Error('Expected an internal BDD command: gitignore, mcp-session, or mcp-probe.');
  }
}

const args = process.argv.slice(2);
main(args).then(code => { process.exitCode = code; }).catch(error => {
  if (args[0] === 'mcp-session') {
    console.error(JSON.stringify({ status: 'blocked', error: error.message }));
  } else {
    const output = args[0] === 'gitignore' ? console.log : console.error;
    output(JSON.stringify({ error: error.message }));
  }
  process.exitCode = args[0] === 'gitignore' ? 2 : 1;
});
