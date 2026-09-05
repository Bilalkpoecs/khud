import chalk from 'chalk';

import { readProfile } from '../lib/profile.js';
import { sync, type Target } from '../lib/sync.js';

export function cmdSync(target: string = 'all'): void {
  const profile = readProfile();

  console.log('');
  console.log(chalk.bold('khud sync') + chalk.gray(` -> ${target}`));
  console.log('');
  const result = sync(profile, target as Target);
  console.log('');
  if (result.failed.length > 0) {
    // syncTargets already set a nonzero exit code. Never print a green tick over it.
    console.log(chalk.red(`\u2717 ${result.failed.length} target(s) failed: ${result.failed.map((item) => item.target).join(', ')}`));
    return;
  }
  console.log(chalk.green('\u2713 done'));
}
