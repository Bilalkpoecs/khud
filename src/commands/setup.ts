import fs from 'node:fs';

import chalk from 'chalk';

import { installHooksForTargets } from './hooks.js';
import { detectInstalledAgents, getAgentName } from '../lib/agents.js';
import { ensureKhudDir, getProfilePath, readProfile, writeProfile } from '../lib/profile.js';
import { buildSeedProfile } from '../lib/seed.js';
import { syncTargets } from '../lib/sync.js';
import type { Profile } from '../lib/types.js';

interface SetupOptions {
  resetProfile?: boolean;
}

export function cmdSetup(options: SetupOptions = {}): void {
  ensureKhudDir();
  const profileAlreadyExists = fs.existsSync(getProfilePath());

  const detections = detectInstalledAgents();
  const targets = dedupeTargets(detections.map((detection) => detection.target));

  console.log('');
  console.log(chalk.bold('khud setup'));
  console.log('');

  if (detections.length === 0) {
    console.log(chalk.yellow('No supported AI coding agents detected.'));
  } else {
    console.log(chalk.bold('Detected agents:'));
    for (const detection of detections) {
      console.log(`  - ${detection.name} (${detection.detectedBy}: ${detection.evidence})`);
    }
    console.log('');
  }

  const profile = loadOrCreateProfile(Boolean(options.resetProfile));
  profile.agents = targets.map((target) => getAgentName(target));
  writeProfile(profile);

  const profileAction = profileAlreadyExists && !options.resetProfile ? 'updated' : 'created';
  console.log(chalk.green(`✓ Profile ${profileAction} at ~/.khud/profile.json`));

  if (targets.length === 0) {
    console.log(chalk.gray('Nothing to wire yet. Install Claude Code, OpenCode, or Cursor, then run khud setup again.'));
    return;
  }

  console.log('');
  console.log('Syncing detected agents...');
  syncTargets(profile, targets);
  console.log('');
  console.log('Installing detected hooks...');
  installHooksForTargets(targets);
  console.log('');
  console.log(chalk.green(`✓ setup complete for ${targets.map((target) => getAgentName(target)).join(', ')}`));
  console.log(chalk.cyan('  Run: khud status'));
}

function loadOrCreateProfile(resetProfile: boolean): Profile {
  if (!resetProfile && fs.existsSync(getProfilePath())) {
    return readProfile();
  }

  return buildSeedProfile();
}

function dedupeTargets<T>(values: T[]): T[] {
  return [...new Set(values)];
}
