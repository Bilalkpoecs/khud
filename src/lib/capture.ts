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

/**
 * Bounds on the two fields a capture can grow the profile with.
 *
 * `project_status` is written to a dynamic session episode, while every
 * `stack_updates` entry can be appended to the static profile. Clamping both at
 * validation keeps the capture and its note bounded, and prevents one capture
 * from exhausting the profile ceiling through a stack update.
 */
export const MAX_PROJECT_STATUS_CHARS = 400;
export const MAX_STACK_ITEM_CHARS = 160;
export const MAX_STACK_UPDATES = 12;

function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3).trimEnd()}...`;
}

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

const NO_WHY = 'not recorded';

/** Case- and whitespace-insensitive identity of a decision. */
function decisionKey(what: string): string {
  return what.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The decisions in a capture, one per distinct `what`.
 *
 * Two decisions with the same `what` in one capture are the same decision: the
 * note id is derived from `date|what|session_id`, so the second silently
 * overwrote the first note on disk while `result.decisions` still counted two,
 * and the Decision-Log idempotence key made the second append a no-op. Merging
 * here is the one place that sees both records: the first occurrence keeps its
 * position, and a later duplicate only fills in what the first is missing.
 */
function normalizeDecisions(raw: unknown): CaptureDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptureDecision[] = [];
  const seen = new Map<string, CaptureDecision>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const what = String(obj.what || '').trim();
    const why = String(obj.why || '').trim();
    if (!what) continue;
    const evidence = normalizeEvidence(obj.evidence);

    const existing = seen.get(decisionKey(what));
    if (existing) {
      if (why && existing.why === NO_WHY) existing.why = why;
      if (evidence && !existing.evidence) existing.evidence = evidence;
      continue;
    }

    const decision: CaptureDecision = evidence
      ? { what, why: why || NO_WHY, evidence }
      : { what, why: why || NO_WHY };
    seen.set(decisionKey(what), decision);
    out.push(decision);
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

/** The fields that make a capture what it is. Deliberately timestamp-free. */
interface CaptureIdentity {
  client: CaptureClient;
  session_id: string;
  date: string;
  project_status: string;
  decisions: CaptureDecision[];
  preferences_learned: CapturePreference[];
  stack_updates: string[];
}

function canonicalCaptureBody(input: CaptureIdentity): unknown {
  return [
    input.client,
    input.session_id,
    input.date,
    input.project_status,
    input.decisions.map((d) => [d.what, d.why, d.evidence?.kind, d.evidence?.quote]),
    input.preferences_learned.map((p) => [p.text, p.evidence?.kind, p.evidence?.quote]),
    input.stack_updates
  ];
}

/**
 * A capture id derived from what the capture says, not from when it was made.
 *
 * `crypto.randomUUID()` used to fill this in, which made every re-fire of a stop
 * hook a brand new capture: finalize keys its fingerprint on
 * `client:session_id:capture_id`, so identical repeats could never collide with
 * each other and each one was processed again. Deriving the id, and the content
 * hash beside it, from the capture's own content is what makes the stop path
 * re-entrant, and is why the OpenCode plugin no longer needs a one-shot flag.
 */
export function deriveCaptureId(input: CaptureIdentity): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalCaptureBody(input)))
    .digest('hex')
    .slice(0, 32);
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
  const createdAt = String(obj.created_at || new Date().toISOString());
  const date = String(obj.date || createdAt.slice(0, 10));
  const projectStatus = clampText(
    String(obj.project_status || '').trim(),
    MAX_PROJECT_STATUS_CHARS
  );
  const decisions = normalizeDecisions(obj.decisions);
  const preferences = normalizePreferences(obj.preferences_learned);
  const stack = Array.isArray(obj.stack_updates)
    ? [
        ...new Set(
          obj.stack_updates
            .map((item) => clampText(String(item).trim(), MAX_STACK_ITEM_CHARS))
            .filter(Boolean)
        )
      ].slice(0, MAX_STACK_UPDATES)
    : [];
  const identity: CaptureIdentity = {
    client,
    session_id: sessionId,
    date,
    project_status: projectStatus,
    decisions,
    preferences_learned: preferences,
    stack_updates: stack
  };
  const captureId = String(obj.capture_id || '').trim() || deriveCaptureId(identity);

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

  // Hashed over the capture's identity, not over `body`: `created_at` moves on
  // every stop-hook fire, so a body hash made two identical captures look
  // different and finalize processed both.
  return {
    ...body,
    content_hash: String(obj.content_hash || contentHash(canonicalCaptureBody(identity)))
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
  let payload: unknown = { reason, raw_text: null };
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isFile()) {
      const rawText = fs.readFileSync(filePath, 'utf8');
      try {
        payload = { reason, raw: JSON.parse(rawText) };
      } catch {
        payload = { reason, raw_text: rawText };
      }
    } else {
      payload = {
        reason,
        raw_text: null,
        entry_type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other'
      };
    }
  } catch (error) {
    payload = {
      reason,
      raw_text: null,
      read_error: (error as NodeJS.ErrnoException).code || (error as Error).message
    };
  }
  atomicWriteJson(dest, payload);
  try {
    if (fs.lstatSync(filePath).isFile()) fs.unlinkSync(filePath);
  } catch {
    // A disappearing or non-regular entry is already safely represented above.
  }
  return dest;
}

export function listInboxCaptures(): string[] {
  ensureCaptureDirs();
  const out: string[] = [];
  if (!fs.existsSync(paths().inboxDir)) return out;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push(full);
      }
    }
  };
  for (const client of fs.readdirSync(paths().inboxDir, { withFileTypes: true })) {
    if (!client.isDirectory()) continue;
    walk(path.join(paths().inboxDir, client.name));
  }
  return out.sort();
}

/**
 * What the hook that happens to be running knows about itself.
 *
 * Only ever a fallback. pending.json is written by whichever agent ended, and
 * any agent's stop hook may be the next one to run, so a hint is trusted for
 * attribution only when the file itself does not say.
 */
export interface LegacyBridgeHint {
  sessionId?: string;
  client?: CaptureClient;
}

/**
 * Convert legacy pending.json into a capture, keeping its own attribution.
 *
 * pending.json carries `agent` (and newer writers carry `client` / `session_id`).
 * Those were being dropped in favour of whichever hook fired: the bridge stamped
 * the *calling* session's id onto the file, so an OpenCode session's summary was
 * filed under the Claude Code session that happened to end next. The hint is now
 * only consulted when the file is silent, and its session id is refused outright
 * when the two clients disagree.
 */
export function pendingToCapture(
  pending: PendingSummary,
  hint: LegacyBridgeHint = {}
): CaptureRecord {
  const ownClient = normalizeClient(pending.client || pending.agent);
  const hintClient = hint.client && hint.client !== 'unknown' ? hint.client : undefined;
  const client = ownClient !== 'unknown' ? ownClient : hintClient || 'unknown';

  const ownSession = String(pending.session_id || '').trim();
  // A hook session id is usable only when the file names no session AND either
  // the file does not say which agent wrote it, or it names the same agent as
  // the hook. An unattributed hint is NOT good enough: a Stop hook that sends no
  // client still belongs to some other agent's session, and stamping its id onto
  // an opencode summary is exactly the cross-agent mixup this guards.
  const hintSessionUsable =
    Boolean(hint.sessionId) && (ownClient === 'unknown' || hintClient === ownClient);
  const sessionId =
    ownSession ||
    (hintSessionUsable ? String(hint.sessionId) : '') ||
    `legacy-${client}-${pending.date}`;

  return validateCapture({
    schema_version: 1,
    client,
    session_id: sessionId,
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
    // matchExplicitDecision is deliberately NOT called here. capture-design.md section 3:
    //   "A 22% false-fire rate is not a threshold problem, it is the wrong mechanism...
    //    delete matchExplicitDecision from the hook path. Do not gate it harder."
    //
    // Its regex fired on the bare word use/ship/go-with anywhere in a message and took
    // everything after it as the decision, with `why` set to the literal placeholder
    // "explicit user decision". The prompt "use it for free like here or in the cli..."
    // became Decisions/2026-07-30-it for free like here or in the cli like you prompt it...
    // Those prompt-titled notes then OUTRANK real decisions on the lexical retrieval path,
    // because the queries are user prompts too. Measured: 2 of 8 golden title queries lost
    // rank 1 to exactly this. Agents write real decisions through capture files instead.
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

function deriveStatus(text: string, client: CaptureClient): string {
  const tail = text.slice(-4000);
  const statusMatch = tail.match(/\*\*Status:\*\*\s*(.+)/i);
  if (statusMatch) return statusMatch[1].trim().slice(0, 240);
  return `Session captured from ${client}`;
}

/**
 * Bridge pending.json into the inbox, claiming the file before reading it.
 *
 * The read-then-unlink order let two stop hooks that fired together both read
 * the same summary and both write a capture: the two captures differ only by
 * the session id each hook supplied, so the content-derived capture id differs
 * too and finalize processes both. `rename` is atomic on POSIX, so exactly one
 * caller gets the bytes and every other caller sees ENOENT and does nothing.
 * The claim name carries the pid so two claims never collide.
 */
export function bridgeLegacyPending(hint: LegacyBridgeHint = {}): string | null {
  const pendingFile = paths().pendingFile;
  if (!fs.existsSync(pendingFile)) return null;
  ensureCaptureDirs();

  const claimed = `${pendingFile}.claim-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(pendingFile, claimed);
  } catch (error) {
    // Lost the race, or the file went away. Either way there is nothing to do.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const pending = JSON.parse(fs.readFileSync(claimed, 'utf8')) as PendingSummary;
    const { path: written } = writeCapture(pendingToCapture(pending, hint));
    if (fs.existsSync(claimed)) fs.unlinkSync(claimed);
    return written;
  } catch (error) {
    quarantineCapture(claimed, `legacy pending invalid: ${(error as Error).message}`);
    return null;
  }
}
