import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { atomicWriteJson, contentHash, safeFileStem } from './atomic.js';
import { resolvePaths } from './paths.js';
import type {
  CaptureClient,
  CaptureDecision,
  CapturePreference,
  CaptureRecord,
  EvidenceKind,
  EvidenceRef,
  PendingSummary
} from './types.js';

const paths = () => resolvePaths();
const CLIENTS = new Set<CaptureClient>(['cursor', 'claude-code', 'opencode', 'unknown']);

export class CaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureValidationError';
  }
}

export function ensureCaptureDirs(): void {
  for (const dir of [
    paths().inboxDir,
    paths().quarantineDir,
    paths().processedDir,
    paths().candidatesDir,
    paths().historyDir
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function normalizeClient(raw: string | undefined): CaptureClient {
  const value = (raw || 'unknown').toLowerCase();
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  if (value === 'cursor') return 'cursor';
  if (value === 'opencode') return 'opencode';
  return 'unknown';
}

/**
 * Which agent a capture came from, inferred from the paths in its hook payload.
 *
 * Claude Code's Stop hook payload carries no `client` field at all, so every capture
 * it produced was filed as `unknown` — 337 of 483 on 2026-07-29 (69.8%), and growing.
 * The transcript path was always sufficient to tell: those captures all recorded
 * `~/.claude/projects/...`.
 *
 * Returns `unknown` only when no path gives an answer, so a genuinely unattributable
 * capture is still distinguishable from a mislabelled one.
 */
export function inferClient(hints: {
  transcriptPath?: string;
  workspace?: string;
}): CaptureClient {
  for (const raw of [hints.transcriptPath, hints.workspace]) {
    const value = (raw || '').toLowerCase();
    if (!value) continue;
    if (value.includes('/.claude/')) return 'claude-code';
    if (value.includes('/.cursor/')) return 'cursor';
    if (value.includes('opencode')) return 'opencode';
  }
  return 'unknown';
}

/**
 * The plain text of a transcript row's content.
 *
 * Claude Code writes user rows as `{type:'user', message:{role, content}}`, where
 * `content` is a string on some rows and an array of typed blocks on others. The
 * previous reader took `row.message` itself and required a string, so it matched
 * neither shape and silently skipped every user message: 16 of 19 rows in one real
 * transcript were block arrays, the other 3 were nested strings.
 */
function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizeEvidence(raw: unknown): EvidenceRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const quote = String(obj.quote || '').trim();
  if (!quote) return undefined;
  const kind = String(obj.kind || 'agent_observation') as EvidenceKind;
  const allowed: EvidenceKind[] = ['explicit_user', 'verified_behavior', 'agent_observation'];
  return {
    kind: allowed.includes(kind) ? kind : 'agent_observation',
    quote,
    message_ref: obj.message_ref ? String(obj.message_ref) : undefined,
    transcript_path: obj.transcript_path ? String(obj.transcript_path) : undefined,
    confidence: clampConfidence(obj.confidence)
  };
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function normalizeDecisions(raw: unknown): CaptureDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptureDecision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const what = String(obj.what || '').trim();
    const why = String(obj.why || '').trim();
    if (!what) continue;
    const evidence = normalizeEvidence(obj.evidence);
    out.push(evidence ? { what, why: why || 'not recorded', evidence } : { what, why: why || 'not recorded' });
  }
  return out;
}

function normalizePreferences(raw: unknown): CapturePreference[] {
  if (!Array.isArray(raw)) return [];
  const out: CapturePreference[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) out.push({ text });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const text = String(obj.text || '').trim();
    if (!text) continue;
    const evidence = normalizeEvidence(obj.evidence);
    out.push(evidence ? { text, evidence } : { text });
  }
  return out;
}

export function validateCapture(raw: unknown): CaptureRecord {
  if (!raw || typeof raw !== 'object') {
    throw new CaptureValidationError('capture must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const client = normalizeClient(String(obj.client || obj.agent || ''));
  if (!CLIENTS.has(client)) {
    throw new CaptureValidationError(`invalid client: ${client}`);
  }
  const sessionId = String(obj.session_id || '').trim();
  if (!sessionId) throw new CaptureValidationError('session_id required');
  const captureId = String(obj.capture_id || '').trim() || crypto.randomUUID();
  const createdAt = String(obj.created_at || new Date().toISOString());
  const date = String(obj.date || createdAt.slice(0, 10));
  const projectStatus = String(obj.project_status || '').trim();
  const decisions = normalizeDecisions(obj.decisions);
  const preferences = normalizePreferences(obj.preferences_learned);
  const stack = Array.isArray(obj.stack_updates)
    ? obj.stack_updates.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const body = {
    schema_version: 1 as const,
    capture_id: captureId,
    client,
    session_id: sessionId,
    created_at: createdAt,
    date,
    workspace: obj.workspace ? String(obj.workspace) : undefined,
    transcript_path: obj.transcript_path ? String(obj.transcript_path) : undefined,
    project_status: projectStatus,
    decisions,
    preferences_learned: preferences,
    stack_updates: stack,
    source: (['agent', 'transcript', 'legacy-pending', 'hook'].includes(String(obj.source))
      ? String(obj.source)
      : 'agent') as CaptureRecord['source']
  };

  return {
    ...body,
    content_hash: String(obj.content_hash || contentHash(body))
  };
}

export function inboxPath(client: CaptureClient, sessionId: string): string {
  return path.join(paths().inboxDir, client, safeFileStem(sessionId, 120));
}

export function writeCapture(raw: unknown): { path: string; record: CaptureRecord } {
  ensureCaptureDirs();
  const record = validateCapture(raw);
  const dir = inboxPath(record.client, record.session_id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${safeFileStem(record.capture_id, 80)}.json`);
  atomicWriteJson(filePath, record);
  return { path: filePath, record };
}

export function quarantineCapture(filePath: string, reason: string): string {
  ensureCaptureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(
    paths().quarantineDir,
    `${stamp}-${safeFileStem(path.basename(filePath), 60)}.json`
  );
  let payload: unknown = { reason };
  try {
    payload = { reason, raw: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch {
    payload = { reason, raw_text: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null };
  }
  atomicWriteJson(dest, payload);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return dest;
}

export function listInboxCaptures(): string[] {
  ensureCaptureDirs();
  const out: string[] = [];
  if (!fs.existsSync(paths().inboxDir)) return out;
  for (const client of fs.readdirSync(paths().inboxDir)) {
    const clientDir = path.join(paths().inboxDir, client);
    if (!fs.statSync(clientDir).isDirectory()) continue;
    for (const session of fs.readdirSync(clientDir)) {
      const sessionDir = path.join(clientDir, session);
      if (!fs.statSync(sessionDir).isDirectory()) continue;
      for (const file of fs.readdirSync(sessionDir)) {
        if (file.endsWith('.json')) out.push(path.join(sessionDir, file));
      }
    }
  }
  return out.sort();
}

export function pendingToCapture(pending: PendingSummary, sessionId?: string): CaptureRecord {
  return validateCapture({
    schema_version: 1,
    capture_id: crypto.randomUUID(),
    client: normalizeClient(pending.agent),
    session_id: sessionId || `legacy-${pending.agent}-${pending.date}`,
    created_at: new Date().toISOString(),
    date: pending.date,
    project_status: pending.project_status || '',
    decisions: pending.decisions || [],
    preferences_learned: (pending.preferences_learned || []).map((text) => ({ text })),
    stack_updates: pending.stack_updates || [],
    source: 'legacy-pending'
  });
}

export function extractFromTranscript(
  transcriptPath: string,
  opts: {
    client: CaptureClient;
    sessionId: string;
    workspace?: string;
  }
): CaptureRecord | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const text = fs.readFileSync(transcriptPath, 'utf8');
  if (!text.trim()) return null;

  const userQuotes = extractUserTexts(text);
  const decisions: CaptureDecision[] = [];
  const preferences: CapturePreference[] = [];

  // Prefer explicit JSON capture blocks written by the agent.
  const jsonBlocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      if (parsed.decisions || parsed.preferences_learned || parsed.project_status) {
        return validateCapture({
          ...parsed,
          client: opts.client,
          session_id: opts.sessionId,
          workspace: opts.workspace,
          transcript_path: transcriptPath,
          source: 'transcript'
        });
      }
    } catch {
      // ignore non-capture json
    }
  }

  for (const quote of userQuotes) {
    const pref = matchExplicitPreference(quote);
    if (pref) {
      preferences.push({
        text: pref,
        evidence: {
          kind: 'explicit_user',
          quote,
          transcript_path: transcriptPath,
          confidence: 0.9
        }
      });
    }
    const decision = matchExplicitDecision(quote);
    if (decision) {
      decisions.push({
        ...decision,
        evidence: {
          kind: 'explicit_user',
          quote,
          transcript_path: transcriptPath,
          confidence: 0.85
        }
      });
    }
  }

  const status = deriveStatus(text, opts.client);
  if (!decisions.length && !preferences.length && !status) return null;

  return validateCapture({
    client: opts.client,
    session_id: opts.sessionId,
    workspace: opts.workspace,
    transcript_path: transcriptPath,
    project_status: status,
    decisions,
    preferences_learned: preferences,
    stack_updates: [],
    source: 'transcript'
  });
}

function extractUserTexts(transcript: string): string[] {
  const lines = transcript.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const message =
        row.message && typeof row.message === 'object'
          ? (row.message as Record<string, unknown>)
          : undefined;
      // The role can sit on the row or inside the nested message envelope.
      const role = String(row.role || row.type || message?.role || '');
      const content = textFromContent(
        row.content ?? row.text ?? message?.content ?? row.message
      ).trim();

      if (!content) {
        continue;
      }
      if (/user/i.test(role)) {
        out.push(content);
      } else if (content.startsWith('Human:')) {
        out.push(content.replace(/^Human:\s*/, '').trim());
      }
    } catch {
      if (line.startsWith('Human:') || line.startsWith('User:')) {
        out.push(line.replace(/^(Human|User):\s*/, '').trim());
      }
    }
  }
  return out.filter(Boolean);
}

function matchExplicitPreference(quote: string): string | null {
  const patterns = [
    /(?:always|never|prefer|please|from now on|remember(?: that)?)\s+(.+)/i,
    /(?:don't|do not)\s+(.+)/i
  ];
  for (const pattern of patterns) {
    const match = quote.match(pattern);
    if (match?.[1] && quote.length < 300) {
      return quote.trim();
    }
  }
  return null;
}

function matchExplicitDecision(quote: string): CaptureDecision | null {
  const match = quote.match(
    /(?:decide|decided|let's go with|go with|use|ship)\s+(.+?)(?:\s+because\s+(.+))?$/i
  );
  if (!match) return null;
  return {
    what: match[1].trim().slice(0, 200),
    why: (match[2] || 'explicit user decision').trim().slice(0, 300)
  };
}

function deriveStatus(text: string, client: CaptureClient): string {
  const tail = text.slice(-4000);
  const statusMatch = tail.match(/\*\*Status:\*\*\s*(.+)/i);
  if (statusMatch) return statusMatch[1].trim().slice(0, 240);
  return `Session captured from ${client}`;
}

export function bridgeLegacyPending(sessionId?: string): string | null {
  if (!fs.existsSync(paths().pendingFile)) return null;
  try {
    const pending = JSON.parse(fs.readFileSync(paths().pendingFile, 'utf8')) as PendingSummary;
    const { path: written } = writeCapture(pendingToCapture(pending, sessionId));
    fs.unlinkSync(paths().pendingFile);
    return written;
  } catch (error) {
    quarantineCapture(paths().pendingFile, `legacy pending invalid: ${(error as Error).message}`);
    return null;
  }
}
