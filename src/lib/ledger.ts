import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from './paths.js';

/**
 * Append-only provenance ledger for ~/.khud/profile.json.
 *
 * profile.json holds only what is CURRENTLY true. Anything added, superseded or
 * removed is recorded here instead. The ledger is never injected into a prompt
 * and never indexed by the retriever, because a growing always-on file is the
 * exact cost this project exists to remove.
 *
 * Schema matches ~/.local/bin/khud-history byte for byte, so both writers can
 * append to the same file and `khud-history list` reads either one.
 */

export type LedgerAction = 'added' | 'superseded' | 'removed' | 'restored';

export interface LedgerEntry {
  action: LedgerAction;
  field: string;
  text: string;
  reason: string;
  supersedes?: string;
  quote?: string;
  source?: string;
}

export function getLedgerPath(): string {
  const override = process.env.KHUD_HISTORY_FILE;
  if (override) return override;
  return path.join(resolvePaths().khudDir, 'profile-history.jsonl');
}

/** Python's `datetime.now(timezone.utc).isoformat(timespec='seconds')`. */
function ledgerTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Record one profile change. Never throws: losing an audit line must not fail
 * the write it describes, and finalize runs inside a session hook.
 */
export function appendLedger(entry: LedgerEntry): void {
  const record: Record<string, string> = {
    ts: ledgerTimestamp(),
    action: entry.action,
    field: entry.field,
    text: entry.text,
    reason: entry.reason
  };
  // Only carry keys that have a value, so the ledger stays readable.
  for (const key of ['supersedes', 'quote', 'source'] as const) {
    const value = entry[key];
    if (value) record[key] = value;
  }

  try {
    const ledgerPath = getLedgerPath();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Audit is best-effort. The profile write it accompanies still stands.
  }
}

/** Record every preference that appeared or vanished between two profiles. */
export function appendPreferenceDiff(
  before: string[],
  after: string[],
  reason: string,
  source: string
): void {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  for (const text of after) {
    if (!beforeSet.has(text)) {
      appendLedger({ action: 'added', field: 'preferences', text, reason, source });
    }
  }
  for (const text of before) {
    if (!afterSet.has(text)) {
      appendLedger({ action: 'removed', field: 'preferences', text, reason, source });
    }
  }
}
