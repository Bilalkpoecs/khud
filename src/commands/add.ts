import chalk from 'chalk';

import { addDecision, ProfileCeilingError, readProfile, writeProfile } from '../lib/profile.js';
import { sync } from '../lib/sync.js';
import type { Profile } from '../lib/types.js';

/**
 * Write the profile, reporting a ceiling breach as a message rather than a stack
 * trace. These are interactive commands: the owner typed the entry and needs to
 * know it was refused and why.
 */
function writeOrReport(profile: Profile, reason: string): boolean {
  try {
    writeProfile(profile, { reason, source: 'khud add' });
    return true;
  } catch (error) {
    if (!(error instanceof ProfileCeilingError)) throw error;
    console.error(chalk.red('✗ refused: ') + error.message);
    return false;
  }
}

export function cmdAddDecision(what: string, why: string): void {
  const profile = readProfile();
  addDecision(profile, {
    date: new Date().toISOString().slice(0, 10),
    what,
    why
  });
  if (!writeOrReport(profile, `decision added by hand: ${what}`)) return;
  console.log(chalk.green(`✓ Decision added: ${what}`));
  sync(profile, 'all');
}

export function cmdAddPreference(preference: string): void {
  const profile = readProfile();
  if (profile.preferences.includes(preference)) {
    console.log(chalk.yellow('Already in preferences.'));
    return;
  }

  profile.preferences.push(preference);
  if (!writeOrReport(profile, 'added by hand via khud add preference')) return;
  console.log(chalk.green('✓ Preference added'));
  sync(profile, 'all');
}

export function cmdAddStack(item: string): void {
  const profile = readProfile();
  if (profile.stack.includes(item)) {
    console.log(chalk.yellow('Already in stack.'));
    return;
  }

  profile.stack.push(item);
  if (!writeOrReport(profile, `stack entry added by hand: ${item}`)) return;
  console.log(chalk.green(`✓ Stack updated: ${item} added`));
  sync(profile, 'all');
}

export function cmdSetStatus(status: string): void {
  const profile = readProfile();
  profile.active_project.status = status;
  if (!writeOrReport(profile, 'project status set by hand')) return;
  console.log(chalk.green('✓ Project status updated'));
  sync(profile, 'all');
}
