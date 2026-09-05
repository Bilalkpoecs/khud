import { spawn } from 'node:child_process';

/**
 * Tell the owner that candidates are waiting for approval.
 *
 * Nothing reaches the profile without an approval now, so with no notice the
 * profile silently freezes instead of silently growing. The count already
 * existed in FinalizeResult and was being thrown away.
 *
 * The link is always the single-candidate deep link for the latest queued rule.
 * Sentinel has no bare `/review` page, so that path 404s; `/review/<id>` renders
 * one rule with its evidence and the approve dialog.
 *
 * Printing is unconditional. notify-send is additional and only when a desktop
 * session exists, so cron and hook runs degrade to print-only rather than
 * failing on a missing DISPLAY.
 */

export const SENTINEL_BASE_URL = 'http://localhost:11437';

/** Deep link for one pending candidate. */
export function sentinelReviewUrl(candidateId: string): string {
  return `${SENTINEL_BASE_URL}/review/${candidateId}`;
}

function hasDesktopSession(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Fire a desktop notification. Never throws: a missing notify-send is not an error. */
function notifyDesktop(title: string, body: string): void {
  try {
    const child = spawn('notify-send', ['--app-name=khud', title, body], {
      detached: true,
      stdio: 'ignore'
    });
    // Losing the notification must not hold the process open or crash it.
    child.on('error', () => {});
    child.unref();
  } catch {
    // notify-send absent or not permitted. Print already covered it.
  }
}

export function announcePendingReview(pendingIds: string[]): void {
  const count = pendingIds.length;
  if (count <= 0) return;

  // Latest queued rule. The rest are one click away on the dashboard.
  const url = sentinelReviewUrl(pendingIds[count - 1]);
  const noun = count === 1 ? 'rule' : 'rules';
  const suffix = count === 1 ? '' : ' (latest)';
  console.log(`${count} ${noun} pending approval${suffix}: ${url}`);

  if (hasDesktopSession()) {
    notifyDesktop(
      `khud: ${count} ${noun} pending`,
      `Nothing reaches your profile until you approve.\n${url}`
    );
  }
}
