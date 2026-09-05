#!/usr/bin/env node
import { Command } from 'commander';

import { cmdAddDecision, cmdAddPreference, cmdAddStack, cmdSetStatus } from './commands/add.js';
import { cmdCaptureValidate, cmdCaptureWrite, cmdMigrateDecisions } from './commands/capture.js';
import { cmdContextDiff, cmdContextPreview } from './commands/context.js';
import { cmdDiff } from './commands/diff.js';
import { cmdFinalize, cmdFinalizeFromHook } from './commands/finalize.js';
import { cmdHistory } from './commands/history.js';
import { cmdHooksInstall } from './commands/hooks.js';
import { cmdInit } from './commands/init.js';
import { cmdMergePending, cmdRejectPending } from './commands/merge.js';
import { cmdNlmEnsure, cmdNlmRecall } from './commands/nlm.js';
import { cmdSetup } from './commands/setup.js';
import { cmdShow } from './commands/show.js';
import { cmdStatus } from './commands/status.js';
import { cmdSync } from './commands/sync.js';

const program = new Command();

program
  .name('khud')
  .description('Cross-agent identity compiler - خود')
  .version('0.2.0');

program
  .command('setup')
  .description('Detect installed agents and wire khud for this machine')
  .option('--reset-profile', 'replace the current profile with the seed profile', false)
  .action((options: { resetProfile: boolean }) => cmdSetup({ resetProfile: options.resetProfile }));

program
  .command('init')
  .description('Initialise khud with your profile')
  .action(async () => cmdInit());

program
  .command('show')
  .description('Print current canonical profile')
  .action(() => cmdShow());

program
  .command('sync')
  .description('Compile profile to all agent formats')
  .option('--to <target>', 'target agent: claude | opencode | cursor | all', 'all')
  .action((options: { to: string }) => cmdSync(options.to));

program
  .command('inject')
  .description('Alias for sync (used by hooks)')
  .option('--to <target>', 'target agent', 'all')
  .action((options: { to: string }) => cmdSync(options.to));

const contextCommand = program.command('context').description('Inspect shared instructions without changing live files');

contextCommand
  .command('preview')
  .description('Preview shared instructions for six agents; exit nonzero when over budget')
  .option('--to <target>', 'preview target: claude | codex | opencode | cursor | pi | hermes | all', 'all')
  .option('--profile <path>', 'use a staged profile instead of the live profile')
  .option('--json', 'print the complete structured preview')
  .action(cmdContextPreview);

contextCommand
  .command('diff')
  .description('Compare each agent\'s generated file against the current profile')
  .option('--to <target>', 'target agent or all', 'all')
  .action(cmdContextDiff);

const addCommand = program.command('add').description('Add to profile');

addCommand
  .command('decision')
  .argument('<what>', 'what was decided')
  .option('--reason <why>', 'why this decision was made', 'not recorded')
  .action((what: string, options: { reason: string }) => cmdAddDecision(what, options.reason));

addCommand
  .command('preference')
  .argument('<text>', 'preference to add')
  .action((text: string) => cmdAddPreference(text));

addCommand
  .command('stack')
  .argument('<item>', 'stack item to add')
  .action((item: string) => cmdAddStack(item));

const setCommand = program.command('set').description('Set profile values');

setCommand
  .command('status')
  .argument('<status>', 'current project status')
  .action((status: string) => cmdSetStatus(status));

program
  .command('finalize')
  .description('Lock and finalize inbox captures into Obsidian + profile')
  .action(async () => cmdFinalize());

program
  .command('finalize-hook')
  .description('Ingest stop-hook JSON from stdin, then finalize')
  .action(async () => cmdFinalizeFromHook());

const captureCommand = program.command('capture').description('Write or validate session captures');

captureCommand
  .command('write')
  .argument('<json>', 'capture JSON string')
  .action((json: string) => cmdCaptureWrite(json));

captureCommand
  .command('validate')
  .argument('<json>', 'capture JSON string')
  .action((json: string) => cmdCaptureValidate(json));

program
  .command('migrate-decisions')
  .description('Split Decision-Log.md into per-entry temporal notes')
  .action(() => cmdMigrateDecisions());

program
  .command('merge-pending')
  .description('Review and approve agent-written session summary (legacy)')
  .option('--auto-approve', 'Skip interactive prompt and approve automatically (for hook use)')
  .action(async (opts: { autoApprove?: boolean }) => cmdMergePending({ autoApprove: opts.autoApprove }));

program
  .command('approve')
  .description('Approve pending session summary')
  .action(async () => cmdMergePending());

program
  .command('reject')
  .description('Discard pending session summary')
  .action(() => cmdRejectPending());

program
  .command('diff')
  .description('Show pending agent-written summary')
  .action(() => cmdDiff());

program
  .command('history')
  .description('Show recent profile changes')
  .option('-n <count>', 'number of entries', '10')
  .action((options: { n: string }) => cmdHistory(Number(options.n)));

program
  .command('rollback')
  .description('Roll back to a previous profile version')
  .option('--to <date>', 'date (YYYY-MM-DD)')
  .action((options: { to?: string }) => {
    console.log('Rollback to', options.to ?? '');
  });

const hooksCommand = program.command('hooks').description('Manage agent hooks');

hooksCommand
  .command('install')
  .option('--for <target>', 'agent to install for: claude | opencode | cursor | all', 'all')
  .action((options: { for: string }) => cmdHooksInstall(options.for));

program
  .command('status')
  .description('Show which agents are wired and files are in place')
  .action(() => cmdStatus());

program
  .command('nlm-ensure')
  .description('Create the khud-session-memory NotebookLM notebook (run once after nlm login)')
  .action(async () => cmdNlmEnsure());

program
  .command('nlm-recall')
  .description('Query recent session context from NotebookLM and write to ~/.khud/nlm-context.md')
  .action(() => cmdNlmRecall());

await program.parseAsync();