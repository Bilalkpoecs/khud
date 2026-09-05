import chalk from 'chalk';

import { injectClaude } from '../adapters/claude.js';
import { injectCodex } from '../adapters/codex.js';
import { injectCursorGlobal } from '../adapters/cursor.js';
import { injectHermes } from '../adapters/hermes.js';
import { injectOpencode } from '../adapters/opencode.js';
import { injectPi } from '../adapters/pi.js';
import type { ProjectionWrite } from '../adapters/projection.js';
import { type SupportedTarget, expandTargets } from './agents.js';
import { displayPath } from './paths.js';
import type { Profile } from './types.js';

export type Target = SupportedTarget | 'all';

const INJECTORS: Record<SupportedTarget, (profile: Profile) => ProjectionWrite> = {
  claude: injectClaude,
  codex: injectCodex,
  opencode: injectOpencode,
  cursor: injectCursorGlobal,
  pi: injectPi,
  hermes: injectHermes,
};

export interface SyncResult {
  written: ProjectionWrite[];
  failed: { target: SupportedTarget; message: string }[];
}

export function sync(profile: Profile, target: Target = 'all'): SyncResult {
  return syncTargets(profile, expandTargets(target));
}

/**
 * Every target is attempted, and every failure is reported.
 *
 * The previous version caught each error and logged it while still exiting 0, so a sync
 * that silently failed to reach an agent looked identical to one that succeeded. Callers
 * now get the failures back and are expected to set a nonzero exit status.
 */
export function syncTargets(profile: Profile, targets: SupportedTarget[]): SyncResult {
  const result: SyncResult = { written: [], failed: [] };

  for (const currentTarget of targets) {
    try {
      const write = INJECTORS[currentTarget](profile);
      result.written.push(write);
      const where = write.files.map((file) => displayPath(file)).join(', ');
      const state = write.changed ? 'updated' : 'unchanged';
      console.log(chalk.green(`✓ ${currentTarget.padEnd(9)} ${state} -> ${where} (${write.estimatedTokens} est tokens)`));
    } catch (error) {
      const message = (error as Error).message;
      result.failed.push({ target: currentTarget, message });
      console.log(chalk.red(`✗ ${currentTarget.padEnd(9)} ${message}`));
    }
  }

  if (result.failed.length > 0) {
    console.log(chalk.red(`${result.failed.length} of ${targets.length} targets failed.`));
    process.exitCode = 1;
  }

  return result;
}
