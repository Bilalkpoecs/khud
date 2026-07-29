import chalk from 'chalk';

import { finalizeInbox, ingestHookPayload } from '../lib/finalize.js';
import { announcePendingReview } from '../lib/notice.js';

export async function cmdFinalize(): Promise<void> {
  const result = await finalizeInbox({ syncAgents: true });
  console.log(
    chalk.green(
      `✓ finalized captures=${result.processed} episodes=${result.episodes} ` +
        `decisions=${result.decisions} prefs=${result.promoted_preferences} ` +
        `review=${result.pending_review} dupes=${result.skipped_duplicates} ` +
        `quarantine=${result.quarantined}`
    )
  );
  announcePendingReview(result.pending_review);
}

export async function cmdFinalizeFromHook(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const rawText = Buffer.concat(chunks).toString('utf8').trim();
  let payload: unknown = {};
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = {};
    }
  }
  await ingestHookPayload(payload);
  await cmdFinalize();
}
