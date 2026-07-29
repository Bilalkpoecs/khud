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
  findCurrentDecisionByWhat,
  markSuperseded,
  writeDecisionNote
} from './decisions.js';
import { buildPreferenceCandidate, promoteEligiblePreferences } from './evidence.js';
import { withLock } from './lock.js';
import { resolvePaths } from './paths.js';
import { ProfileCeilingError, readProfile, writeProfile } from './profile.js';
import {
  isHookStubStatus,
  shouldWriteSessionEpisode,
  writeSessionEpisode
} from './sessionNote.js';
import { sync } from './sync.js';
import type { CaptureRecord, FinalizeResult } from './types.js';

const paths = () => resolvePaths();

function fingerprintsPath(): string {
  return path.join(paths().processedDir, 'fingerprints.json');
}

interface FingerprintStore {
  hashes: Record<string, string>;
}

function loadFingerprints(): FingerprintStore {
  const file = fingerprintsPath();
  if (!fs.existsSync(file)) return { hashes: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as FingerprintStore;
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

  if (sessionId) {
    bridgeLegacyPending(sessionId);
  } else {
    bridgeLegacyPending();
  }

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

function processOne(
  filePath: string,
  fingerprints: FingerprintStore,
  result: FinalizeResult
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
    return false;
  }

  let vaultTouched = false;

  if (shouldWriteSessionEpisode(record)) {
    writeSessionEpisode(record);
    result.episodes += 1;
    vaultTouched = true;
  }

  for (const decision of record.decisions) {
    const prior = findCurrentDecisionByWhat(decision.what);
    if (prior) markSuperseded(prior, record.date);
    writeDecisionNote(decision, record, {
      supersedes: prior ? path.basename(prior, '.md') : undefined
    });
    appendLegacyDecisionLog(decision, record.date);
    result.decisions += 1;
    vaultTouched = true;
  }

  const profile = readProfile();
  const preferenceCandidates = record.preferences_learned.map((pref) =>
    buildPreferenceCandidate(pref, record, profile)
  );
  const promoted = promoteEligiblePreferences(preferenceCandidates, profile);
  result.promoted_preferences += promoted.promoted;
  result.pending_review += promoted.pending;

  for (const item of record.stack_updates) {
    if (!profile.stack.includes(item)) profile.stack.push(item);
  }
  const status = record.project_status?.trim() || '';
  if (status && !isHookStubStatus(status)) {
    profile.active_project.status = status;
  }

  try {
    writeProfile(promoted.profile, {
      reason: `capture ${record.capture_id} from ${record.client} session ${record.session_id}`,
      source: 'finalize'
    });
  } catch (error) {
    if (!(error instanceof ProfileCeilingError)) throw error;
    // Fail closed: the profile is untouched and the capture is not marked
    // processed, so it is retried once something has been retired.
    result.ceiling_blocked += 1;
    console.error(error.message);
    return vaultTouched;
  }

  fingerprints.hashes[fpKey] = record.content_hash;
  markProcessed(filePath, record);
  result.processed += 1;
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
      skipped_duplicates: 0,
      ceiling_blocked: 0
    };

    bridgeLegacyPending();
    const fingerprints = loadFingerprints();
    let wrote = false;
    for (const filePath of listInboxCaptures()) {
      wrote = processOne(filePath, fingerprints, result) || wrote;
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
