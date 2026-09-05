import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteJson, atomicWriteText } from './atomic.js';
import { appendPreferenceDiff } from './ledger.js';
import type { Decision, Profile, PendingSummary } from './types.js';
import { resolvePaths } from './paths.js';

/**
 * Hard byte ceiling for profile.json.
 *
 * Every byte here is injected at session start into three harnesses, so it is
 * paid three times per session for as long as the entry exists. 8192 B is about
 * 2000 tokens. The same constant is enforced by sentinel
 * (`sentinel-app/packages/shared/src/index.ts`, PROFILE_CEILING_BYTES); the two
 * must not drift, or khud can write a file sentinel then refuses to save.
 */
export const PROFILE_CEILING_BYTES = 8192;

/** Thrown instead of writing a profile that breaches the ceiling. Fail closed. */
export class ProfileCeilingError extends Error {
  constructor(
    readonly attemptedBytes: number,
    readonly ceilingBytes: number
  ) {
    super(
      `profile.json would be ${attemptedBytes} B, over the ${ceilingBytes} B ceiling by ` +
        `${attemptedBytes - ceilingBytes} B. Nothing was written. Retire an entry first: ` +
        `http://localhost:11437`
    );
    this.name = 'ProfileCeilingError';
  }
}

function p() {
  return resolvePaths();
}

export function getKhudDir(): string {
  return p().khudDir;
}

export function getProfilePath(): string {
  return path.join(p().khudDir, 'profile.json');
}

export function getPendingPath(): string {
  return p().pendingFile;
}

export function getHistoryDir(): string {
  return p().historyDir;
}

export function readProfile(): Profile {
  const profilePath = getProfilePath();
  if (!fs.existsSync(profilePath)) {
    throw new Error('Profile not found. Run: khud init');
  }

  return normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')) as Profile);
}

/**
 * The exact bytes a `writeProfile` call would put on disk, without writing.
 *
 * `updated` is stamped here the same way the writer stamps it, and the trailing
 * newline is included, so a caller can check the ceiling before it starts a
 * multi-file commit. Works on a deep copy: probing must not mutate the profile
 * the caller is still assembling.
 */
export function serializeProfile(profile: Profile): string {
  const probe = normalizeProfile(JSON.parse(JSON.stringify(profile)) as Profile);
  probe.updated = new Date().toISOString().slice(0, 10);
  return `${JSON.stringify(probe, null, 2)}\n`;
}

/**
 * A profile's content with the write timestamp taken out.
 *
 * `updated` is restamped by every write, so any byte-level comparison of two
 * serializations reports a difference even when nothing semantic changed. This
 * is what finalize compares to decide whether a capture has anything to write:
 * a capture that adds no stack entry, no status and no approved preference must
 * not be measured against the ceiling, because a full profile was rejecting
 * captures that would not have added a byte of content and they then sat in the
 * inbox forever. Works on a deep copy.
 */
export function profileSemanticKey(profile: Profile): string {
  const probe = normalizeProfile(JSON.parse(JSON.stringify(profile)) as Profile);
  probe.updated = '';
  return JSON.stringify(probe);
}

/**
 * Throw `ProfileCeilingError` if this profile would breach the ceiling.
 *
 * Exists so finalize can fail closed BEFORE it writes vault notes. Previously
 * the only check lived inside `writeProfile`, which runs last, so a blocked
 * capture had already written its session note, its decision notes and a
 * Decision-Log entry by the time it was refused.
 */
export function assertProfileWithinCeiling(profile: Profile): void {
  const attemptedBytes = Buffer.byteLength(serializeProfile(profile), 'utf8');
  if (attemptedBytes > PROFILE_CEILING_BYTES) {
    throw new ProfileCeilingError(attemptedBytes, PROFILE_CEILING_BYTES);
  }
}

export interface WriteProfileOptions {
  /** Why this changed. Recorded in the ledger against each affected entry. */
  reason?: string;
  /** What made the change, e.g. `finalize`, `add`, `merge`. */
  source?: string;
}

/**
 * The single chokepoint for every profile mutation: finalize, add, merge, setup
 * and init all land here. The ceiling check and the ledger both live here rather
 * than in the promote path, because `merge.ts` pushes preferences without going
 * anywhere near evidence classification.
 *
 * Throws `ProfileCeilingError` and writes nothing when the result would breach
 * the ceiling.
 */
export function writeProfile(profile: Profile, options: WriteProfileOptions = {}): void {
  ensureKhudDir();
  const profilePath = getProfilePath();
  const historyDir = getHistoryDir();
  const normalizedProfile = normalizeProfile(profile);

  normalizedProfile.updated = new Date().toISOString().slice(0, 10);

  // Measured on the exact bytes that get written, not an estimate.
  //
  // The trailing newline matters: sentinel's writer emits one
  // (`sentinel-app/backend/src/profile/profile.service.ts`, serialize()). Without
  // it the two writers produce files one byte apart and each enforces the ceiling
  // against its own count, which is the drift the shared constant exists to stop.
  // One serializer for the probe and the write, so `assertProfileWithinCeiling`
  // can never disagree with what actually lands on disk.
  const serialized = serializeProfile(normalizedProfile);
  const attemptedBytes = Buffer.byteLength(serialized, 'utf8');
  if (attemptedBytes > PROFILE_CEILING_BYTES) {
    throw new ProfileCeilingError(attemptedBytes, PROFILE_CEILING_BYTES);
  }

  const previousPreferences = readPreferencesOrEmpty(profilePath);

  if (fs.existsSync(profilePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(profilePath, path.join(historyDir, `${stamp}.json`));
  }

  // Writes the same bytes that were measured above, newline included.
  atomicWriteText(profilePath, serialized);

  appendPreferenceDiff(
    previousPreferences,
    normalizedProfile.preferences,
    options.reason || 'profile write',
    options.source || 'khud'
  );
}

/** Preferences currently on disk, or none if the profile is absent or unreadable. */
function readPreferencesOrEmpty(profilePath: string): string[] {
  try {
    if (!fs.existsSync(profilePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as Partial<Profile>;
    return Array.isArray(parsed.preferences) ? parsed.preferences : [];
  } catch {
    // An unreadable prior profile means we cannot diff, not that we cannot write.
    return [];
  }
}

export function readPending(): PendingSummary | null {
  const pendingPath = getPendingPath();
  if (!fs.existsSync(pendingPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as PendingSummary;
}

export function writePending(summary: PendingSummary): void {
  ensureKhudDir();
  atomicWriteJson(getPendingPath(), summary);
}

export function clearPending(): void {
  const pendingPath = getPendingPath();
  if (fs.existsSync(pendingPath)) {
    fs.unlinkSync(pendingPath);
  }
}

export function ensureKhudDir(): void {
  const paths = p();
  fs.mkdirSync(paths.khudDir, { recursive: true });
  fs.mkdirSync(paths.historyDir, { recursive: true });
  fs.mkdirSync(paths.inboxDir, { recursive: true });
  fs.mkdirSync(paths.quarantineDir, { recursive: true });
  fs.mkdirSync(paths.processedDir, { recursive: true });
  fs.mkdirSync(paths.candidatesDir, { recursive: true });
}

export function addDecision(profile: Profile, decision: Decision): Profile {
  profile.recent_decisions.unshift(decision);
  profile.recent_decisions = profile.recent_decisions.slice(0, 20);
  return profile;
}

function normalizeProfile(profile: Profile): Profile {
  const fallbackDate = profile.updated || new Date().toISOString().slice(0, 10);

  profile.recent_decisions = profile.recent_decisions.map((decision) => ({
    date: decision.date || fallbackDate,
    what: decision.what,
    why: decision.why
  }));

  return profile;
}
