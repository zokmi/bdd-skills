import { isCliEntry } from './lib/cli-entry.mjs';

async function dispatch(command, args) {
  switch (command) {
    case 'archive-index': {
      const { archiveIndexCommand } = await import('./lib/archive-manager.mjs');
      return archiveIndexCommand(args);
    }
    case 'recompress': {
      const { recompressCommand } = await import('./lib/recompress.mjs');
      return recompressCommand(args);
    }
    case 'prune': {
      const { pruneCommand } = await import('./lib/prune.mjs');
      return pruneCommand(args);
    }
    case 'archive': {
      const { archiveCommand } = await import('./lib/archive.mjs');
      return archiveCommand(args);
    }
    case 'extract': {
      const { extractCommand } = await import('./lib/extract.mjs');
      return extractCommand(args);
    }
    case 'mask-evidence': {
      const { maskCommand } = await import('./lib/mask-evidence.mjs');
      return maskCommand(args);
    }
    case 'loopback-slot': {
      const { loopbackCommand } = await import('./lib/loopback-slot.mjs');
      return loopbackCommand(args);
    }
    case 'prepare-worktree-mcp': {
      const { prepareWorktreeMcp } = await import('./lib/prepare-worktree-mcp.mjs');
      return prepareWorktreeMcp(args);
    }
    case 'stop-slot-services': {
      const { stopSlotCommand } = await import('./lib/stop-slot-services.mjs');
      return stopSlotCommand(args);
    }
    case 'verification': {
      const { verificationCommand } = await import('./lib/verification.mjs');
      return verificationCommand(args);
    }
    case 'parallel-summary': {
      const { parallelSummary } = await import('./lib/parallel-summary.mjs');
      return parallelSummary(args);
    }
    case 'modules': {
      const { modulesCommand } = await import('./lib/module-query.mjs');
      return modulesCommand(args);
    }
    case 'quality-plan': {
      const { qualityPlan } = await import('./lib/quality-plan.mjs');
      return qualityPlan(args);
    }
    case 'gitignore': {
      const { parseArgs } = await import('node:util');
      const { ensureGitignore } = await import('./lib/gitignore.mjs');
      const { values } = parseArgs({
        args, options: { repo: { type: 'string', default: '.' }, check: { type: 'boolean' } },
      });
      const result = ensureGitignore(values.repo, values.check);
      console.log(JSON.stringify(result));
      return result.failures.length || result.trackedOutputs.length ? 1 : 0;
    }
    case 'mcp-session': {
      const { main } = await import('./worktree-mcp-session.mjs');
      await main(args);
      return 0;
    }
    case 'mcp-probe': {
      const { main } = await import('./probe-mcp-route.mjs');
      await main(args);
      return 0;
    }
    default:
      throw new Error('Expected an internal BDD command: modules, quality-plan, verification, parallel-summary, gitignore, loopback-slot, prepare-worktree-mcp, stop-slot-services, mcp-session, mcp-probe, archive, archive-index, recompress, prune, extract, or mask-evidence.');
  }
}

export async function runCli([command, ...args]) {
  try {
    process.exitCode = await dispatch(command, args);
  } catch (error) {
    const output = command === 'gitignore' ? console.log : console.error;
    const payload = command === 'mcp-session' ? { status: 'blocked', error: error.message } : { error: error.message };
    output(JSON.stringify(payload));
    process.exitCode = ['gitignore', 'modules', 'verification', 'parallel-summary', 'stop-slot-services'].includes(command) ? 2 : 1;
  }
}

if (isCliEntry(import.meta)) {
  await runCli(process.argv.slice(2));
}
