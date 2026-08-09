/**
 * Screen wake lock.
 *
 * The browser drops the lock whenever the page is hidden, so it has to be
 * re-acquired on `visibilitychange`. Without that, backgrounding the app for a
 * moment mid-session leaves the screen free to sleep for the rest of it.
 */

let lock = null;
let wanted = false;

async function acquire() {
  if (!wanted || lock || !('wakeLock' in navigator)) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch (e) {
    // Denied on low battery, or unsupported. Not worth surfacing.
    lock = null;
  }
}

export function request() {
  wanted = true;
  acquire();
}

export function release() {
  wanted = false;
  if (lock) {
    lock.release().catch(() => {});
    lock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquire();
});
