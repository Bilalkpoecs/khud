import readline from 'node:readline';

import chalk from 'chalk';

import {
  clearPending,
  ProfileCeilingError,
  readPending,
  readProfile,
  writeProfile
} from '../lib/profile.js';
import { saveSession } from '../lib/nlm.js';
import { sync } from '../lib/sync.js';
import type { Decision, PendingSummary } from '../lib/types.js';

export async function cmdMergePending(opts: { autoApprove?: boolean } = {}): Promise<void> {
  const pending = readPending() as PendingSummary | null;

  if (!pending) {
    process.exit(0);
  }

  const hasContent =
    pending.decisions.length > 0 ||
    pending.preferences_learned.length > 0 ||
    Boolean(pending.project_status?.trim()) ||
    Boolean(pending.stack_updates?.length);

  if (!hasContent) {
    clearPending();
    process.exit(0);
  }

  console.log('');
  console.log(chalk.bold.cyan(`khud: ${pending.agent}`) + chalk.gray(` - ${pending.date}`));
  console.log('');

  if (pending.decisions.length > 0) {
    console.log(chalk.bold('Decisions captured:'));
    for (const decision of pending.decisions) {
      console.log(chalk.green('  +') + ` ${decision.what} - ${chalk.gray(decision.why)}`);
    }
  }

  if (pending.preferences_learned.length > 0) {
    console.log(chalk.bold('Preferences learned:'));
    for (const preference of pending.preferences_learned) {
      console.log(chalk.green('  +') + ` ${preference}`);
    }
  }

  if (pending.project_status) {
    console.log(chalk.bold('Project status:'));
    console.log(chalk.green('  ->') + ` ${pending.project_status}`);
  }

  if (pending.stack_updates.length > 0) {
    console.log(chalk.bold('Stack updates:'));
    for (const update of pending.stack_updates) {
      console.log(chalk.green('  +') + ` ${update}`);
    }
  }

  console.log('');

  if (!opts.autoApprove) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.bold('Approve? [Y/n] '), resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'n') {
      clearPending();
      console.log(chalk.gray('Rejected - pending cleared.'));
      return;
    }
  }

  const profile = readProfile();

  if (pending.decisions.length > 0) {
    const normalizedDecisions: Decision[] = pending.decisions.map((decision) => ({
      date: decision.date || pending.date || new Date().toISOString().slice(0, 10),
      what: decision.what,
      why: decision.why
    }));

    profile.recent_decisions.unshift(...normalizedDecisions);
    profile.recent_decisions = profile.recent_decisions.slice(0, 20);
  }

  for (const preference of pending.preferences_learned) {
    if (!profile.preferences.includes(preference)) {
      profile.preferences.push(preference);
    }
  }

  if (pending.project_status) {
    profile.active_project.status = pending.project_status;
  }

  for (const item of pending.stack_updates ?? []) {
    if (!profile.stack.includes(item)) {
      profile.stack.push(item);
    }
  }

  // This path already has the owner's approval from the prompt above, so it is
  // not routed through sentinel. The ceiling still applies.
  try {
    writeProfile(profile, {
      reason: `khud merge approved at the terminal, agent ${pending.agent}, ${pending.date}`,
      source: 'merge'
    });
  } catch (error) {
    if (!(error instanceof ProfileCeilingError)) throw error;
    console.error(chalk.red('✗ refused: ') + error.message);
    console.error(chalk.gray('Pending kept. Retire an entry, then run khud merge again.'));
    return;
  }

  // Save to NotebookLM before clearing - silent fail, advisory only
  saveSession(pending);

  clearPending();

  console.log('');
  sync(profile, 'all');
  console.log('');
  console.log(chalk.bold.green('✓ Profile updated · all agents synced'));
}

export function cmdRejectPending(): void {
  if (!readPending()) {
    console.log(chalk.gray('No pending updates.'));
    return;
  }

  clearPending();
  console.log(chalk.gray('Pending update cleared.'));
}
