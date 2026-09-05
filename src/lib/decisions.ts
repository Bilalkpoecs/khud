import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { atomicWriteText, safeFileStem } from './atomic.js';
import { resolvePaths } from './paths.js';
import type { CaptureDecision, CaptureRecord } from './types.js';

const paths = () => resolvePaths();

export interface TemporalDecisionNote {
  id: string;
  date: string;
  what: string;
  why: string;
  status: 'current' | 'superseded' | 'rejected' | 'contradicted';
  valid_from: string;
  valid_to?: string;
  supersedes?: string;
  session_id: string;
  client: string;
  capture_id: string;
  filePath: string;
}

/** Hidden idempotence key carried by every khud-written Decision-Log block. */
function decisionLogMarker(key: string): string {
  return `<!-- khud-decision: ${key} -->`;
}

function decisionId(date: string, what: string, sessionId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${date}|${what}|${sessionId}`)
    .digest('hex')
    .slice(0, 12);
}

export function ensureDecisionsDir(): void {
  fs.mkdirSync(paths().decisionsDir, { recursive: true });
}

export function renderDecisionNote(note: Omit<TemporalDecisionNote, 'filePath'>): string {
  const lines = [
    '---',
    `id: ${note.id}`,
    `status: ${note.status}`,
    `valid_from: ${note.valid_from}`,
    note.valid_to ? `valid_to: ${note.valid_to}` : null,
    note.supersedes ? `supersedes: ${note.supersedes}` : null,
    `session_id: ${note.session_id}`,
    `client: ${note.client}`,
    `capture_id: ${note.capture_id}`,
    '---',
    '',
    `# ${note.date} - ${note.what}`,
    '',
    `**What:** ${note.what}`,
    `**Why:** ${note.why}`,
    '**Impact:** (auto-logged from session)',
    ''
  ];
  return lines.filter((line) => line !== null).join('\n');
}

/**
 * Where one capture's decision note lives, without writing it.
 *
 * Finalize needs this before it looks for a prior note, so it can tell a real
 * predecessor from the note it is about to rewrite.
 */
export function decisionNoteTarget(
  decision: CaptureDecision,
  record: CaptureRecord
): { id: string; filePath: string } {
  const id = decisionId(record.date, decision.what, record.session_id);
  const stem = safeFileStem(`${record.date}-${decision.what}`, 90);
  return { id, filePath: path.join(paths().decisionsDir, `${stem}-${id}.md`) };
}

/** The `supersedes` already recorded in a note on disk, if any. */
function recordedSupersedes(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const match = fs.readFileSync(filePath, 'utf8').match(/^supersedes:\s*(.+)$/m);
    const value = match?.[1]?.trim();
    return value || undefined;
  } catch {
    // An unreadable note means no chain to carry, not a failure to write.
    return undefined;
  }
}

/** Keep the most informative reason when separate captures target one note. */
function mergedReason(filePath: string, incoming: string): string {
  let existing = '';
  try {
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, 'utf8').match(/\*\*Why:\*\*\s*(.+)/i)?.[1]?.trim() || '';
    }
  } catch {
    return incoming;
  }
  if (!existing || existing === 'not recorded') return incoming;
  if (!incoming || incoming === 'not recorded') return existing;
  if (existing.length !== incoming.length) {
    return existing.length > incoming.length ? existing : incoming;
  }
  return existing.localeCompare(incoming) <= 0 ? existing : incoming;
}

export function writeDecisionNote(
  decision: CaptureDecision,
  record: CaptureRecord,
  opts: { supersedes?: string; status?: TemporalDecisionNote['status'] } = {}
): TemporalDecisionNote {
  ensureDecisionsDir();
  const { id, filePath } = decisionNoteTarget(decision, record);

  // A note can never supersede itself. The id is derived from date|what|session_id, so
  // re-finalizing one capture makes findCurrentDecisionByWhat return the very note about
  // to be rewritten, and the caller then passes it back as `supersedes`. Observed in the
  // vault: notes carrying `supersedes:` equal to their own id. Drop it rather than write a
  // self-referential chain that any temporal query would have to special-case.
  const requested =
    opts.supersedes && !opts.supersedes.endsWith(id) ? opts.supersedes : undefined;

  // Dropping the self-reference must not drop the real predecessor with it. A
  // replay rewrites this note from the capture alone, and the capture has never
  // known what the note superseded, so the chain recorded on the first pass was
  // being erased on every retry. Carry it forward unless a genuine predecessor
  // is being named now.
  const carried = recordedSupersedes(filePath);
  const supersedes =
    requested || (carried && !carried.endsWith(id) ? carried : undefined);

  const note: TemporalDecisionNote = {
    id,
    date: record.date,
    what: decision.what,
    why: mergedReason(filePath, decision.why),
    status: opts.status || 'current',
    valid_from: record.date,
    supersedes,
    session_id: record.session_id,
    client: record.client,
    capture_id: record.capture_id,
    filePath
  };
  atomicWriteText(filePath, renderDecisionNote(note));
  return note;
}

export function markSuperseded(filePath: string, validTo: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  const updated = text
    .replace(/status:\s*\w+/i, 'status: superseded')
    .replace(/(valid_from:\s*[^\n]+)/i, `$1\nvalid_to: ${validTo}`);
  atomicWriteText(filePath, updated);
}

export function findCurrentDecisionByWhat(what: string): string | null {
  ensureDecisionsDir();
  const needle = what.trim().toLowerCase();
  for (const file of fs.readdirSync(paths().decisionsDir)) {
    if (!file.endsWith('.md') || file.startsWith('Decision-Log')) continue;
    const full = path.join(paths().decisionsDir, file);
    const text = fs.readFileSync(full, 'utf8');
    if (!/^status:\s*current\s*$/im.test(text) && !text.includes('status: current')) continue;
    const whatMatch = text.match(/\*\*What:\*\*\s*(.+)/i);
    if (whatMatch && whatMatch[1].trim().toLowerCase() === needle) return full;
  }
  return null;
}

/**
 * Mirror one decision into the human-readable Decision-Log.
 *
 * The append is keyed on `key` (the decision note id: date|what|session_id) and
 * written into the block as an HTML comment, so a re-run of the same capture is
 * a no-op. Without that key this was the one non-idempotent write in finalize:
 * a capture blocked by the profile ceiling had already prepended its block, and
 * every retry prepended another copy of it.
 *
 * Returns true only when a new block was written.
 */
export function appendLegacyDecisionLog(
  decision: CaptureDecision,
  date: string,
  key?: string
): boolean {
  // Keep a thin newest-first mirror for humans; canonical notes are per-file.
  if (!fs.existsSync(paths().decisionLogFile)) return false;

  let current: string;
  try {
    current = fs.readFileSync(paths().decisionLogFile, 'utf8');
  } catch {
    return false;
  }

  const marker = key ? decisionLogMarker(key) : null;
  if (marker && current.includes(marker)) {
    const markerIndex = current.indexOf(marker);
    const blockStart = Math.max(0, current.lastIndexOf('\n## ', markerIndex) + 1);
    const nextBlock = current.indexOf('\n## ', markerIndex + marker.length);
    const blockEnd = nextBlock === -1 ? current.length : nextBlock + 1;
    const block = current.slice(blockStart, blockEnd);
    const updated = block
      .replace(/\*\*What:\*\*\s*[^\n]*/i, `**What:** ${decision.what}`)
      .replace(/\*\*Why:\*\*\s*[^\n]*/i, `**Why:** ${decision.why}`);
    if (updated !== block) {
      atomicWriteText(
        paths().decisionLogFile,
        `${current.slice(0, blockStart)}${updated}${current.slice(blockEnd)}`
      );
    }
    return false;
  }

  const entry = [
    `## ${date} - ${decision.what.slice(0, 80)}`,
    `**What:** ${decision.what}`,
    `**Why:** ${decision.why}`,
    '**Impact:** (auto-logged from session)',
    marker,
    ''
  ]
    .filter((line) => line !== null)
    .join('\n');

  const parts = current.split(/^---$/m);
  if (parts.length < 2) {
    atomicWriteText(paths().decisionLogFile, `${current.trim()}\n\n---\n\n${entry}`);
    return true;
  }
  const head = parts[0] + '---\n';
  const rest = parts.slice(1).join('---');
  atomicWriteText(paths().decisionLogFile, `${head}\n${entry}${rest.replace(/^\n*/, '\n')}`);
  return true;
}

export interface LegacyDecision {
  date: string;
  what: string;
  why: string;
}

export function parseLegacyDecisionLog(text: string): LegacyDecision[] {
  const blocks = text.split(/^## /m).slice(1);
  const out: LegacyDecision[] = [];
  for (const block of blocks) {
    const first = block.split('\n')[0] || '';
    const dateMatch = first.match(/^(20\d{2}-\d{2}-\d{2})\s*-\s*(.+)$/);
    const whatLine = block.match(/\*\*What:\*\*\s*(.+)/i);
    const whyLine = block.match(/\*\*Why:\*\*\s*(.+)/i);
    if (!dateMatch || !whatLine) continue;
    out.push({
      date: dateMatch[1],
      what: whatLine[1].trim(),
      why: (whyLine?.[1] || 'migrated').trim()
    });
  }
  return out;
}

export function migrateLegacyDecisionLog(): { migrated: number; archive: string | null } {
  ensureDecisionsDir();
  if (!fs.existsSync(paths().decisionLogFile)) return { migrated: 0, archive: null };
  const text = fs.readFileSync(paths().decisionLogFile, 'utf8');
  const parsed = parseLegacyDecisionLog(text);
  let migrated = 0;
  for (const decision of parsed) {
    const id = decisionId(decision.date, decision.what, 'legacy-migration');
    const stem = safeFileStem(`${decision.date}-${decision.what}`, 90);
    const filePath = path.join(paths().decisionsDir, `${stem}-${id}.md`);
    if (fs.existsSync(filePath)) continue;
    atomicWriteText(
      filePath,
      renderDecisionNote({
        id,
        date: decision.date,
        what: decision.what,
        why: decision.why,
        status: 'current',
        valid_from: decision.date,
        session_id: 'legacy-migration',
        client: 'unknown',
        capture_id: 'legacy-migration'
      })
    );
    migrated += 1;
  }
  if (!fs.existsSync(paths().decisionArchiveFile)) {
    fs.copyFileSync(paths().decisionLogFile, paths().decisionArchiveFile);
  }
  return { migrated, archive: paths().decisionArchiveFile };
}
