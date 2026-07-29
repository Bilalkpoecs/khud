import { spawn } from 'node:child_process';

/**
 * Tell the owner that candidates are waiting for approval.
 *
 * Nothing reaches the profile without an approval now, so with no notice the
 * profile silently freezes instead of silently growing. The count already
 * existed in FinalizeResult and was being thrown away.
 *
 * Printing is unconditional. notify-send is additional and only when a desktop
 * session exists, so cron and hook runs degrade to print-only rather than
 * failing on a missing DISPLAY.
 */

export const SENTINEL_REVIEW_URL = 'http://localhost:11437/review';

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

export function announcePendingReview(count: number): void {
  if (count <= 0) return;

  const noun = count === 1 ? 'rule' : 'rules';
  console.log(`${count} ${noun} pending approval: ${SENTINEL_REVIEW_URL}`);

  if (hasDesktopSession()) {
    notifyDesktop(
      `khud: ${count} ${noun} pending`,
      `Nothing reaches your profile until you approve.\n${SENTINEL_REVIEW_URL}`
    );
  }
}
