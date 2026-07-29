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
  Profile
} from './types.js';

const paths = () => resolvePaths();

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

export function saveCandidate(candidate: MemoryCandidate): void {
  ensureCandidatesDir();
  atomicWriteJson(path.join(paths().candidatesDir, `${candidate.id}.json`), candidate);
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
  const status: MemoryCandidate['status'] = contradictions.length
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

/**
 * Persist candidates and apply any already marked `current`.
 *
 * `buildPreferenceCandidate` no longer produces `current`, so in the capture
 * path this only ever queues. The `current` branch stays because sentinel
 * approval sets that status, and this is the one place that turns an approved
 * candidate into a profile entry.
 */
export function promoteEligiblePreferences(
  candidates: MemoryCandidate[],
  profile: Profile
): { profile: Profile; promoted: number; pending: number } {
  let promoted = 0;
  let pending = 0;
  for (const candidate of candidates) {
    saveCandidate(candidate);
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
    }
  }
  return { profile, promoted, pending };
}
