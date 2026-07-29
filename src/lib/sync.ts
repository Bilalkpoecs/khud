import chalk from 'chalk';

import { injectClaude } from '../adapters/claude.js';
import { injectCursorGlobal } from '../adapters/cursor.js';
import { injectOpencode } from '../adapters/opencode.js';
import { type SupportedTarget, expandTargets } from './agents.js';
import { displayPath, resolvePaths } from './paths.js';
import type { Profile } from './types.js';

export type Target = SupportedTarget | 'all';
const PATHS = resolvePaths();

export function sync(profile: Profile, target: Target = 'all'): void {
  syncTargets(profile, expandTargets(target));
}

export function syncTargets(profile: Profile, targets: SupportedTarget[]): void {
  for (const currentTarget of targets) {
    try {
      if (currentTarget === 'claude') {
        injectClaude(profile);
        console.log(chalk.green(`✓ claude    -> ${displayPath(PATHS.claudeMarkdown)}`));
      }

      if (currentTarget === 'opencode') {
        injectOpencode(profile);
        console.log(chalk.green(`✓ opencode  -> ${displayPath(PATHS.opencodeIdentityFile)}`));
      }

      if (currentTarget === 'cursor') {
        injectCursorGlobal(profile);
        console.log(chalk.green(`✓ cursor    -> ${displayPath(PATHS.cursorRuleFile)}`));
      }
    } catch (error) {
      console.log(chalk.red(`✗ ${currentTarget} - ${(error as Error).message}`));
    }
  }
}
