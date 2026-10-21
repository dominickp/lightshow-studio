import { STORAGE_KEYS, readPreference, writePreference } from './preferences';

/** Stored once the notice is dismissed; the notice never returns after that. */
const DISMISSED = 'dismissed';

/**
 * Show the one-time photosensitivity notice on a first visit.
 *
 * A small toast pinned to the top: it never blocks the stage. Dismissing it
 * writes a `localStorage` flag, so it stays gone across reloads and sessions.
 * Clearing site data brings it back, which is the intended way to reset it.
 * Called before the app's async startup so it paints immediately instead of
 * after the renderer is ready.
 */
export function setupPhotosensitivityNotice(): void {
  const notice = document.getElementById('photosensitivity');
  const dismiss = document.getElementById('photosensitivity-dismiss');
  if (!(notice instanceof HTMLElement) || !(dismiss instanceof HTMLButtonElement)) return;
  if (readPreference(STORAGE_KEYS.photosensitivity) === DISMISSED) return;

  const close = (): void => {
    writePreference(STORAGE_KEYS.photosensitivity, DISMISSED);
    notice.hidden = true;
  };

  // The whole toast is a dismiss target, which is easier to hit than the ×.
  // The × stays for its affordance and as the keyboard-reachable control.
  notice.addEventListener('click', close);

  notice.hidden = false;
}
