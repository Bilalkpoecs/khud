import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { atomicWriteJson } from './atomic.js';
import {
  bridgeLegacyPending,
  extractFromTranscript,
  listInboxCaptures,
  inferClient,
  normalizeClient,
  quarantineCapture,
  validateCapture,
  writeCapture
} from './capture.js';
import {
  appendLegacyDecisionLog,
  decisionNoteTarget,
  findCurrentDecisionByWhat,
  markSuperseded,
  writeDecisionNote
} from './decisions.js';
import {
  buildPreferenceCandidate,
  persistCandidates,
  planPreferencePromotions
} from './evidence.js';
import { withLock } from './lock.js';
import { resolvePaths } from './paths.js';
import {
  ProfileCeilingError,
  assertProfileWithinCeiling,
  profileSemanticKey,
  readProfile,
  writeProfile
} from './profile.js';
import {
  shouldWriteSessionEpisode,
  writeSessionEpisode
} from './sessionNote.js';
import { sync } from './sync.js';
import type { CaptureRecord, FinalizeResult, MemoryCandidate, Profile } from './types.js';

const paths = () => resolvePaths();

function fingerprintsPath(): string {
  return path.join(paths().processedDir, 'fingerprints.json');
}

interface FingerprintStore {
  hashes: Record<string, string>;
  /** Consecutive ceiling refusals per capture, so a hopeless one stops retrying. */
  ceiling_blocks?: Record<string, number>;
}

/**
 * How many ceiling refusals a single capture gets before it is quarantined.
 *
 * A capture that cannot fit is retried on every finalize, and the inbox is
 * processed in name order, so one oversized record kept re-printing its refusal
 * and blocked nothing else but never left either. Three runs is enough to cover
 * "the owner is about to retire an entry"; past that the record is parked in
 * quarantine where it is still readable and re-playable by hand.
 */
const MAX_CEILING_ATTEMPTS = 3;

function loadFingerprints(): FingerprintStore {
  const file = fingerprintsPath();
  if (!fs.existsSync(file)) return { hashes: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FingerprintStore>;
    return {
      hashes: parsed?.hashes && typeof parsed.hashes === 'object' ? parsed.hashes : {},
      ceiling_blocks:
        parsed?.ceiling_blocks && typeof parsed.ceiling_blocks === 'object'
          ? parsed.ceiling_blocks
          : {}
    };
  } catch {
    return { hashes: {} };
  }
}

function saveFingerprints(store: FingerprintStore): void {
  atomicWriteJson(fingerprintsPath(), store);
}

function markProcessed(filePath: string, record: CaptureRecord): void {
  const destDir = path.join(paths().processedDir, record.client, record.session_id);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(filePath));
  fs.renameSync(filePath, dest);
}

function maybeReindex(hadWrites: boolean): void {
  if (!hadWrites) return;
  const reindex = path.join(
    paths().desktopDir,
    'bilal-workspace/Active/turbovec-obsidian/hooks/session_reindex.sh'
  );
  if (!fs.existsSync(reindex)) return;
  // Fire-and-forget: must not block finalize lock release.
  // The watcher daemon catches up independently.
  const child = spawn('bash', [reindex], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

export async function ingestHookPayload(raw: unknown): Promise<CaptureRecord | null> {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sessionId = String(
    data.session_id || data.conversation_id || data.sessionID || ''
  ).trim();
  const transcriptPath = String(
    data.transcript_path || data.transcriptPath || ''
  ).trim();
  const workspace = String(
    data.cwd || data.workspace || (Array.isArray(data.workspace_roots) ? data.workspace_roots[0] : '')
  ).trim();

  // A stated client wins; otherwise infer from the paths. Claude Code's Stop hook
  // sends no client field, which is why 69.8% of captures were filed as unknown.
  const stated = normalizeClient(String(data.client || data.agent || ''));
  const client =
    stated === 'unknown' ? inferClient({ transcriptPath, workspace }) : stated;

  // The hint is a fallback only. A pending.json that names its own client or
  // session keeps them, so an unrelated stop hook cannot re-attribute it.
  bridgeLegacyPending({ sessionId: sessionId || undefined, client });

  if (sessionId && transcriptPath) {
    const extracted = extractFromTranscript(transcriptPath, {
      client,
      sessionId,
      workspace: workspace || undefined
    });
    if (extracted) {
      writeCapture(extracted);
      return extracted;
    }
  }

  // Minimal episode so stop still records something when agent forgot pending.json
  if (sessionId) {
    const { record } = writeCapture({
      client,
      session_id: sessionId,
      workspace: workspace || undefined,
      transcript_path: transcriptPath || undefined,
      project_status: `Session ${sessionId.slice(0, 8)} ended (${client})`,
      decisions: [],
      preferences_learned: [],
      stack_updates: [],
      source: 'hook'
    });
    return record;
  }

  return null;
}

/** Everything one capture would change, computed without touching disk. */
interface CapturePlan {
  profile: Profile;
  candidates: MemoryCandidate[];
  promoted: number;
  pending: number;
  pendingIds: string[];
  writeEpisode: boolean;
  /** False when the capture changes no profile content, only its timestamp. */
  profileChanged: boolean;
}

/**
 * Decide what a capture does. Writes nothing, so it is safe to abandon.
 *
 * Throws `ProfileCeilingError` when the resulting profile would not fit, which
 * is the whole reason planning is separate: the ceiling has to be known before
 * the first vault note exists, not after.
 */
function planCapture(record: CaptureRecord): CapturePlan {
  const profile = readProfile();
  const before = profileSemanticKey(profile);
  const candidates = record.preferences_learned.map((pref) =>
    buildPreferenceCandidate(pref, record, profile)
  );
  const promotion = planPreferencePromotions(candidates, profile);

  // Only a capture that actually changes profile content has to fit under the
  // ceiling. Most captures change nothing there — no approved preference, a
  // stack entry already present, the same status — and measuring those against
  // the ceiling meant a full profile refused captures whose only profile effect
  // would have been restamping `updated`. They then sat in the inbox and their
  // session notes and decisions were never written.
  const profileChanged = profileSemanticKey(promotion.profile) !== before;
  if (profileChanged) assertProfileWithinCeiling(promotion.profile);

  return {
    profile: promotion.profile,
    candidates,
    promoted: promotion.promoted,
    pending: promotion.pending,
    pendingIds: promotion.pendingIds,
    writeEpisode: shouldWriteSessionEpisode(record),
    profileChanged
  };
}

/**
 * Apply a plan. The profile lands first, so a ceiling refusal that slipped past
 * planning (sentinel can grow the file between plan and commit) still aborts
 * before anything is written to the vault.
 *
 * Every write here is keyed and repeatable: candidate ids are content-derived,
 * session notes dedupe on a body fingerprint, decision notes are path-stable,
 * and the Decision-Log append carries the note id as its idempotence key. A
 * capture that dies part-way is therefore safe to retry.
 */
function commitCapture(
  filePath: string,
  record: CaptureRecord,
  plan: CapturePlan,
  fingerprints: FingerprintStore,
  result: FinalizeResult,
  decisionTargets: Set<string>
): boolean {
  // A capture with nothing to add skips the write entirely rather than rewriting
  // the same content under a new `updated` stamp.
  if (plan.profileChanged) {
    try {
      writeProfile(plan.profile, {
        reason: `capture ${record.capture_id} from ${record.client} session ${record.session_id}`,
        source: 'finalize'
      });
    } catch (error) {
      if (!(error instanceof ProfileCeilingError)) throw error;
      // Fail closed: profile untouched, vault untouched, capture left in the inbox
      // so it is retried once something has been retired.
      result.ceiling_blocked += 1;
      console.error(error.message);
      return false;
    }
  }

  persistCandidates(plan.candidates);

  let vaultTouched = false;
  if (plan.writeEpisode) {
    writeSessionEpisode(record);
    result.episodes += 1;
    vaultTouched = true;
  }

  for (const decision of record.decisions) {
    const target = decisionNoteTarget(decision, record);
    const prior = findCurrentDecisionByWhat(decision.what);
    // On a replay the "prior" note IS the note about to be rewritten. Marking it
    // superseded and then handing it back as its own predecessor is what wrote
    // self-referential chains; skipping both keeps the recorded chain intact
    // (writeDecisionNote carries it forward).
    const predecessor =
      prior && path.resolve(prior) !== path.resolve(target.filePath) ? prior : null;
    if (predecessor) markSuperseded(predecessor, record.date);
    const note = writeDecisionNote(decision, record, {
      supersedes: predecessor ? path.basename(predecessor, '.md') : undefined
    });
    appendLegacyDecisionLog({ ...decision, why: note.why }, record.date, note.id);
    const canonicalTarget = path.resolve(target.filePath);
    if (!decisionTargets.has(canonicalTarget)) {
      decisionTargets.add(canonicalTarget);
      result.decisions += 1;
    }
    vaultTouched = true;
  }

  result.promoted_preferences += plan.promoted;
  result.pending_review += plan.pending;
  result.pending_review_ids.push(...plan.pendingIds);

  fingerprints.hashes[`${record.client}:${record.session_id}:${record.capture_id}`] =
    record.content_hash;
  markProcessed(filePath, record);
  result.processed += 1;
  return vaultTouched;
}

/**
 * Count one ceiling refusal, and quarantine the capture once it is clear no
 * retry will ever help. Without this a capture that cannot fit is re-read,
 * re-planned and re-refused on every finalize for the life of the machine.
 */
function noteCeilingBlock(
  filePath: string,
  fpKey: string,
  fingerprints: FingerprintStore,
  result: FinalizeResult
): void {
  const blocks = fingerprints.ceiling_blocks || (fingerprints.ceiling_blocks = {});
  const attempts = (blocks[fpKey] || 0) + 1;
  blocks[fpKey] = attempts;
  if (attempts < MAX_CEILING_ATTEMPTS) return;
  quarantineCapture(
    filePath,
    `refused by the profile ceiling ${attempts} times; parked so it cannot stall the inbox`
  );
  result.quarantined += 1;
  delete blocks[fpKey];
}

function clearCeilingBlock(fingerprints: FingerprintStore, fpKey: string): void {
  if (fingerprints.ceiling_blocks) delete fingerprints.ceiling_blocks[fpKey];
}

function processOne(
  filePath: string,
  fingerprints: FingerprintStore,
  result: FinalizeResult,
  decisionTargets: Set<string>
): boolean {
  let record: CaptureRecord;
  try {
    record = validateCapture(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    quarantineCapture(filePath, `invalid capture: ${(error as Error).message}`);
    result.quarantined += 1;
    return false;
  }

  const fpKey = `${record.client}:${record.session_id}:${record.capture_id}`;
  if (fingerprints.hashes[fpKey] === record.content_hash) {
    markProcessed(filePath, record);
    result.skipped_duplicates += 1;
    clearCeilingBlock(fingerprints, fpKey);
    return false;
  }

  const blockedBefore = result.ceiling_blocked;
  let plan: CapturePlan | null = null;
  try {
    plan = planCapture(record);
  } catch (error) {
    if (!(error instanceof ProfileCeilingError)) throw error;
    result.ceiling_blocked += 1;
    console.error(error.message);
  }

  // commitCapture can also hit the ceiling: sentinel may grow the profile between
  // plan and commit. Both paths report through result.ceiling_blocked.
  const vaultTouched = plan
    ? commitCapture(filePath, record, plan, fingerprints, result, decisionTargets)
    : false;

  if (result.ceiling_blocked > blockedBefore) {
    noteCeilingBlock(filePath, fpKey, fingerprints, result);
    return false;
  }
  clearCeilingBlock(fingerprints, fpKey);
  return vaultTouched;
}

export async function finalizeInbox(opts: { syncAgents?: boolean } = {}): Promise<FinalizeResult> {
  return withLock(paths().lockDir, async () => {
    const result: FinalizeResult = {
      processed: 0,
      quarantined: 0,
      episodes: 0,
      decisions: 0,
      promoted_preferences: 0,
      pending_review: 0,
      pending_review_ids: [],
      skipped_duplicates: 0,
      ceiling_blocked: 0
    };

    bridgeLegacyPending();
    const fingerprints = loadFingerprints();
    const decisionTargets = new Set<string>();
    let wrote = false;
    for (const filePath of listInboxCaptures()) {
      wrote = processOne(filePath, fingerprints, result, decisionTargets) || wrote;
    }
    saveFingerprints(fingerprints);

    if (wrote && opts.syncAgents !== false) {
      try {
        sync(readProfile(), 'all');
      } catch {
        // soft-fail sync
      }
    }
    maybeReindex(wrote);
    return result;
  });
}
