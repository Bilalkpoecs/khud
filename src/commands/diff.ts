import chalk from 'chalk';

import { readPending } from '../lib/profile.js';

export function cmdDiff(): void {
  const pending = readPending();

  if (!pending) {
    console.log(chalk.gray('No pending updates.'));
    return;
  }

  console.log('');
  console.log(chalk.bold.cyan(`Pending from ${pending.agent}`) + chalk.gray(` - ${pending.date}`));
  console.log('');

  if (pending.decisions.length > 0) {
    console.log(chalk.bold('Decisions:'));
    for (const decision of pending.decisions) {
      console.log(chalk.green('  +') + ` ${decision.what} - ${chalk.gray(decision.why)}`);
    }
  }

  if (pending.preferences_learned.length > 0) {
    console.log(chalk.bold('Preferences:'));
    for (const preference of pending.preferences_learned) {
      console.log(chalk.green('  +') + ` ${preference}`);
    }
  }

  if (pending.project_status) {
    console.log(chalk.bold('Status update:'));
    console.log(chalk.green('  ->') + ` ${pending.project_status}`);
  }

  if (pending.stack_updates.length > 0) {
    console.log(chalk.bold('Stack updates:'));
    for (const update of pending.stack_updates) {
      console.log(chalk.green('  +') + ` ${update}`);
    }
  }

  console.log('');
  console.log(chalk.gray('Run: khud approve  or  khud reject'));
}
