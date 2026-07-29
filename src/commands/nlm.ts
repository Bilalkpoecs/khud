import chalk from 'chalk';

import { ensureNotebook, recallContext } from '../lib/nlm.js';
import { displayPath } from '../lib/paths.js';
import { NLM_CONTEXT } from '../lib/nlm.js';

export async function cmdNlmEnsure(): Promise<void> {
  console.log('');
  console.log(chalk.bold('khud nlm-ensure'));
  console.log('');

  const notebookId = ensureNotebook();

  if (!notebookId) {
    console.log(chalk.red('✗ Could not create or find notebook. Run: nlm login'));
    process.exit(1);
  }

  console.log(chalk.green('✓ notebook ready') + chalk.gray(` id=${notebookId}`));
  console.log('');
}

export function cmdNlmRecall(): void {
  recallContext();
  console.log(chalk.gray(`nlm-recall -> ${displayPath(NLM_CONTEXT)}`));
}
