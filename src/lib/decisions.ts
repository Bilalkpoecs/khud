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

export function writeDecisionNote(
  decision: CaptureDecision,
  record: CaptureRecord,
  opts: { supersedes?: string; status?: TemporalDecisionNote['status'] } = {}
): TemporalDecisionNote {
  ensureDecisionsDir();
  const id = decisionId(record.date, decision.what, record.session_id);
  const stem = safeFileStem(`${record.date}-${decision.what}`, 90);
  const filePath = path.join(paths().decisionsDir, `${stem}-${id}.md`);

  // A note can never supersede itself. The id is derived from date|what|session_id, so
  // re-finalizing one capture makes findCurrentDecisionByWhat return the very note about
  // to be rewritten, and the caller then passes it back as `supersedes`. Observed in the
  // vault: notes carrying `supersedes:` equal to their own id. Drop it rather than write a
  // self-referential chain that any temporal query would have to special-case.
  const supersedes =
    opts.supersedes && !opts.supersedes.endsWith(id) ? opts.supersedes : undefined;

  const note: TemporalDecisionNote = {
    id,
    date: record.date,
    what: decision.what,
    why: decision.why,
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

export function appendLegacyDecisionLog(decision: CaptureDecision, date: string): void {
  // Keep a thin newest-first mirror for humans; canonical notes are per-file.
  if (!fs.existsSync(paths().decisionLogFile)) return;
  const entry = [
    `## ${date} - ${decision.what.slice(0, 80)}`,
    `**What:** ${decision.what}`,
    `**Why:** ${decision.why}`,
    '**Impact:** (auto-logged from session)',
    ''
  ].join('\n');
  const current = fs.readFileSync(paths().decisionLogFile, 'utf8');
  const parts = current.split(/^---$/m);
  if (parts.length < 2) {
    atomicWriteText(paths().decisionLogFile, `${current.trim()}\n\n---\n\n${entry}`);
    return;
  }
  const head = parts[0] + '---\n';
  const rest = parts.slice(1).join('---');
  atomicWriteText(paths().decisionLogFile, `${head}\n${entry}${rest.replace(/^\n*/, '\n')}`);
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
