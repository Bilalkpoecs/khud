import chalk from 'chalk';

import { validateCapture, writeCapture } from '../lib/capture.js';
import { migrateLegacyDecisionLog } from '../lib/decisions.js';

export function cmdCaptureWrite(rawJson: string): void {
  const parsed = JSON.parse(rawJson) as unknown;
  const { path: filePath, record } = writeCapture(parsed);
  console.log(chalk.green(`✓ capture ${record.capture_id} -> ${filePath}`));
}

export function cmdCaptureValidate(rawJson: string): void {
  const record = validateCapture(JSON.parse(rawJson) as unknown);
  console.log(JSON.stringify(record, null, 2));
}

export function cmdMigrateDecisions(): void {
  const result = migrateLegacyDecisionLog();
  console.log(
    chalk.green(
      `✓ migrated ${result.migrated} decisions` +
        (result.archive ? `; archive ${result.archive}` : '')
    )
  );
}
