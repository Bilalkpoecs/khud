import chalk from 'chalk';

import { readProfile } from '../lib/profile.js';
import { sync, type Target } from '../lib/sync.js';

export function cmdSync(target: string = 'all'): void {
  const profile = readProfile();

  console.log('');
  console.log(chalk.bold('khud sync') + chalk.gray(` -> ${target}`));
  console.log('');
  sync(profile, target as Target);
  console.log('');
  console.log(chalk.green('✓ done'));
}
