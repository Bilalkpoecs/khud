import fs from 'node:fs';
import readline from 'node:readline';

import chalk from 'chalk';

import { ensureKhudDir, getProfilePath, writeProfile } from '../lib/profile.js';
import { buildSeedProfile } from '../lib/seed.js';
import { sync } from '../lib/sync.js';

export async function cmdInit(): Promise<void> {
  ensureKhudDir();

  if (fs.existsSync(getProfilePath())) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.yellow('Profile already exists. Overwrite with seed? [y/N] '), resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Keeping existing profile.');
      return;
    }
  }

  const seedProfile = buildSeedProfile();
  writeProfile(seedProfile);
  console.log(chalk.green('✓ Profile created at ~/.khud/profile.json'));
  console.log('');
  console.log('Syncing to all agents...');
  sync(seedProfile, 'all');
  console.log('');
  console.log(chalk.green('✓ khud ready. Run: khud show'));
  console.log('');
  console.log('Next: wire hooks automatically with:');
  console.log(chalk.cyan('  khud hooks install'));
}
