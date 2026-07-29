import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const STALE_LOCK_MS = 5 * 60_000; // 5 minutes — a previous crash left it

/**
 * POSIX-atomic directory lock. No new dependency.
 * ponytail: mkdir lock, upgrade to flock if multi-host contention appears.
 * If a lock is older than STALE_LOCK_MS, force-release it (defense-in-depth
 * for subprocess hangs inside the locked section — the primary fix lives
 * in callers, this guard is a safety net).
 */
export async function withLock<T>(
  lockDir: string,
  fn: () => Promise<T> | T,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  // Force-release a stale lock left by a previous crash or hang.
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      fs.rmSync(lockDir, { recursive: true });
    }
  } catch {
    // lockDir doesn't exist or stat failed — carry on
  }

  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockDir}`);
      }
      await sleep(POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // lock release best-effort
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
