import chalk from 'chalk';

import { readProfile } from '../lib/profile.js';

export function cmdShow(): void {
  const profile = readProfile();

  console.log('');
  console.log(chalk.bold.green(`khud - ${profile.name}`));
  console.log(chalk.gray(`Updated: ${profile.updated}`));
  console.log('');

  console.log(chalk.bold('Stack'));
  console.log(`  ${profile.stack.join(', ')}`);
  console.log('');

  console.log(chalk.bold('Active Project'));
  console.log(`  ${profile.active_project.name} - ${profile.active_project.description}`);
  console.log(`  Status: ${profile.active_project.status}`);
  console.log('');

  console.log(chalk.bold(`Preferences`) + chalk.gray(` (${profile.preferences.length})`));
  for (const preference of profile.preferences) {
    console.log(`  - ${preference}`);
  }
  console.log('');

  console.log(chalk.bold('Recent Decisions') + chalk.gray(` (${profile.recent_decisions.length})`));
  for (const decision of profile.recent_decisions.slice(0, 5)) {
    console.log(`  ${chalk.gray(decision.date)} - ${decision.what} (${decision.why})`);
  }
  console.log('');

  console.log(chalk.bold('Agents'));
  console.log(`  ${profile.agents.join(', ')}`);
}
