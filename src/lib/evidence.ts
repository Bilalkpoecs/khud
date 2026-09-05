import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { atomicWriteJson } from './atomic.js';
import { resolvePaths } from './paths.js';
import type {
  CapturePreference,
  CaptureRecord,
  EvidenceRef,
  MemoryCandidate,
  MemoryStatus,
  Profile
} from './types.js';

const paths = () => resolvePaths();

/**
 * Statuses that represent a decision already taken about a candidate.
 *
 * Candidate ids are content-derived, so the same rule seen in a later session,
 * or the same capture replayed, rewrites the same file. An unguarded rewrite
 * turned an explicit `rejected` back into `pending_review` and re-queued a rule
 * the owner had already turned down, and put an approved one back in the queue.
 */
const TERMINAL_CANDIDATE_STATUSES = new Set<MemoryStatus>([
  'promoted',
  'current',
  'rejected',
  'superseded'
]);

export function isTerminalCandidateStatus(status: MemoryStatus): boolean {
  return TERMINAL_CANDIDATE_STATUSES.has(status);
}

/** One candidate by id, or null when absent or unreadable. */
export function readCandidate(id: string): MemoryCandidate | null {
  try {
    const file = path.join(paths().candidatesDir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as MemoryCandidate;
  } catch {
    return null;
  }
}

export function ensureCandidatesDir(): void {
  fs.mkdirSync(paths().candidatesDir, { recursive: true });
}

export function quoteInTranscript(quote: string, transcriptPath?: string): boolean {
  if (!quote?.trim()) return false;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  const text = fs.readFileSync(transcriptPath, 'utf8');
  return text.includes(quote.trim());
}

export function classifyPreference(
  pref: CapturePreference,
  record: CaptureRecord
): EvidenceRef {
  const base = pref.evidence || {
    kind: 'agent_observation' as const,
    quote: pref.text,
    transcript_path: record.transcript_path,
    confidence: 0.4
  };

  if (
    base.kind === 'explicit_user' &&
    quoteInTranscript(base.quote, record.transcript_path || base.transcript_path)
  ) {
    return { ...base, kind: 'explicit_user', confidence: Math.max(base.confidence, 0.9) };
  }

  if (base.kind === 'explicit_user' && !record.transcript_path) {
    // No transcript to verify: keep as observation until proven.
    return { ...base, kind: 'agent_observation', confidence: Math.min(base.confidence, 0.5) };
  }

  return { ...base, kind: 'agent_observation' };
}

export function findContradictions(text: string, profile: Profile): string[] {
  const normalized = text.toLowerCase();
  const hits: string[] = [];
  for (const preference of profile.preferences) {
    if (isContradictory(normalized, preference.toLowerCase())) {
      hits.push(preference);
    }
  }
  return hits;
}

function isContradictory(a: string, b: string): boolean {
  if (a === b) return false;
  const negA = /\b(never|don't|do not|avoid|no longer)\b/.test(a);
  const negB = /\b(never|don't|do not|avoid|no longer)\b/.test(b);
  const coreA = a.replace(/\b(never|don't|do not|avoid|no longer|always|prefer|please)\b/g, '').trim();
  const coreB = b.replace(/\b(never|don't|do not|avoid|no longer|always|prefer|please)\b/g, '').trim();
  if (!coreA || !coreB) return false;
  const overlap = tokenOverlap(coreA, coreB);
  return overlap >= 0.6 && negA !== negB;
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter((t) => t.length > 2));
  const tb = new Set(b.split(/\s+/).filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

export function loadBehaviorEvidence(): MemoryCandidate[] {
  ensureCandidatesDir();
  const out: MemoryCandidate[] = [];
  for (const file of fs.readdirSync(paths().candidatesDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(paths().candidatesDir, file), 'utf8')) as MemoryCandidate);
    } catch {
      // skip broken candidate files
    }
  }
  return out;
}

/** Write a candidate, never regressing a status the owner already settled. */
export function saveCandidate(candidate: MemoryCandidate): void {
  ensureCandidatesDir();
  const prior = readCandidate(candidate.id);
  const next: MemoryCandidate =
    prior &&
    isTerminalCandidateStatus(prior.status) &&
    !isTerminalCandidateStatus(candidate.status)
      ? {
          ...candidate,
          status: prior.status,
          valid_to: prior.valid_to,
          supersedes: prior.supersedes
        }
      : candidate;
  atomicWriteJson(path.join(paths().candidatesDir, `${next.id}.json`), next);
}

export function buildPreferenceCandidate(
  pref: CapturePreference,
  record: CaptureRecord,
  profile: Profile
): MemoryCandidate {
  const evidence = classifyPreference(pref, record);
  const contradictions = findContradictions(pref.text, profile);
  const id = crypto
    .createHash('sha256')
    .update(`${record.session_id}:${pref.text}`)
    .digest('hex')
    .slice(0, 16);

  // Nothing reaches the profile without an explicit approval in sentinel, not
  // even a verbatim quote. Evidence is still classified and recorded so the
  // review UI can show why a candidate is trustworthy, which is what makes
  // approving a strong candidate a glance rather than an investigation.
  //
  // A status the owner already settled wins over a freshly computed one, so a
  // replay neither re-queues a rejected rule nor counts it as pending review.
  const prior = readCandidate(id);
  const status: MemoryCandidate['status'] =
    prior && isTerminalCandidateStatus(prior.status)
      ? prior.status
      : contradictions.length
        ? 'contradicted'
        : 'pending_review';

  if (!contradictions.length && evidence.kind !== 'explicit_user') {
    // verified_behavior: second independent session with same preference text
    const prior = loadBehaviorEvidence().filter(
      (c) =>
        c.kind === 'preference' &&
        c.text === pref.text &&
        c.session_id !== record.session_id &&
        c.status !== 'rejected'
    );
    if (prior.length >= 1) {
      evidence.kind = 'verified_behavior';
      evidence.confidence = Math.max(evidence.confidence, 0.8);
    }
  }

  return {
    id,
    kind: 'preference',
    text: pref.text,
    evidence,
    status,
    valid_from: record.date,
    contradicts: contradictions.length ? contradictions : undefined,
    session_id: record.session_id,
    client: record.client,
    capture_id: record.capture_id
  };
}

export interface PreferencePromotionPlan {
  profile: Profile;
  promoted: number;
  pending: number;
  /** Ids in queue order so the caller can deep-link the latest pending rule. */
  pendingIds: string[];
}

/**
 * What these candidates would do to the profile. Writes nothing.
 *
 * Split out of `promoteEligiblePreferences` so finalize can compute the whole
 * profile mutation, check the byte ceiling, and only then start writing. The
 * returned profile is the same object, mutated in place, which is what every
 * caller wants.
 *
 * `buildPreferenceCandidate` no longer produces `current`, so in the capture
 * path this only ever queues. The `current` branch stays because sentinel
 * approval sets that status, and this is the one place that turns an approved
 * candidate into a profile entry.
 */
export function planPreferencePromotions(
  candidates: MemoryCandidate[],
  profile: Profile
): PreferencePromotionPlan {
  let promoted = 0;
  let pending = 0;
  const pendingIds: string[] = [];
  for (const candidate of candidates) {
    // Both tokens mean approved. Sentinel writes 'promoted'; 'current' is khud's
    // own older spelling. Matching only one silently drops approved entries.
    if (candidate.status === 'current' || candidate.status === 'promoted') {
      if (!profile.preferences.includes(candidate.text)) {
        profile.preferences.push(candidate.text);
        promoted += 1;
      }
      continue;
    }
    if (candidate.status === 'pending_review' || candidate.status === 'contradicted') {
      pending += 1;
      pendingIds.push(candidate.id);
    }
  }
  return { profile, promoted, pending, pendingIds };
}

/**
 * Write candidate files. Ids are content-derived, so re-running a capture
 * rewrites the same files rather than queueing the rule twice.
 */
export function persistCandidates(candidates: MemoryCandidate[]): void {
  for (const candidate of candidates) saveCandidate(candidate);
}

/** Persist candidates, then apply any already marked approved. */
export function promoteEligiblePreferences(
  candidates: MemoryCandidate[],
  profile: Profile
): PreferencePromotionPlan {
  persistCandidates(candidates);
  return planPreferencePromotions(candidates, profile);
}
