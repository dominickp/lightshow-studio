import type { Arrangement, TimelineMode } from '../arrangement';
import type { Post } from '../post';
import type { Stage } from '../stage';
import type { UiElements } from './elements';

/**
 * Everything the global shortcuts act on. Passed in rather than imported so
 * this module stays free of the app's mutable state and can be read as a plain
 * list of key bindings.
 */
export interface KeyboardDeps {
  ui: Pick<UiElements, 'hint' | 'zoomFit'>;
  arrangement: Arrangement;
  stage: Stage;
  post: Post;
  syncButtons(): void;
  togglePlay(): void;
  toggleMute(): void;
  toggleStats(): void;
  toggleControls(): void;
  seekBy(direction: 1 | -1, coarse: boolean): void;
  applyTimelineMode(mode: TimelineMode): void;
  clearLoop(): void;
  setZoom(zoom: number): void;
  zoomOut(zoom: number): number;
  /** Ctrl+C: copy the selection and refresh the inspector. */
  copySelection(): void;
  saveProject(): void;
}

const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLSelectElement ||
  target instanceof HTMLTextAreaElement;

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(target.type);
  }
  return target instanceof HTMLElement && target.isContentEditable;
};

/**
 * Register the document-wide key bindings. Handlers are installed in the same
 * order as the capture-phase ones were originally written, because the first
 * capture listener that calls `stopPropagation` wins.
 */
export function installKeyboardShortcuts(deps: KeyboardDeps): void {
  const { ui, arrangement, stage, post, syncButtons } = deps;

  /* Spaces must always play/pause, whatever control a previous click left
   * focused — an open `<select>` dropdown or a focused button would otherwise
   * swallow it. Listen in the capture phase and stop propagation so neither the
   * native control nor the shortcut handler below sees the key. Text entry
   * fields keep Space for typing. */
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.code !== 'Space' || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      if (target instanceof HTMLElement) target.blur();
      deps.togglePlay();
    },
    true,
  );

  /* Delete/Backspace remove the selected clips the same way: capture phase, so
   * a focused slider, button or `<select>` does not swallow the key. Real text
   * entry still keeps Backspace for editing, and the key is only claimed when
   * there is actually a clip selection (Backspace may otherwise mean "back"). */
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (!arrangement.hasSelection) return;
      event.preventDefault();
      event.stopPropagation();
      arrangement.deleteSelected();
    },
    true,
  );

  /* Ctrl/Cmd-accelerated editing and zoom. */
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (isTextEntry(event.target)) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      deps.setZoom(arrangement.zoomLevel * 1.25);
    } else if (event.key === '-') {
      event.preventDefault();
      deps.setZoom(deps.zoomOut(arrangement.zoomLevel * 0.8));
    } else if (event.key === '0') {
      event.preventDefault();
      ui.zoomFit.click();
    } else if (event.key === 'z' || event.key === 'Z') {
      event.preventDefault();
      if (event.shiftKey) arrangement.redo();
      else arrangement.undo();
    } else if (event.key === 'y' || event.key === 'Y') {
      event.preventDefault();
      arrangement.redo();
    } else if (event.key === 'c' || event.key === 'C') {
      if (arrangement.selectionCount === 0) return;
      event.preventDefault();
      deps.copySelection();
    } else if (event.key === 'v' || event.key === 'V') {
      event.preventDefault();
      // Shift pastes at the pointer instead of after the selection, so a copied
      // block can be dropped exactly where the user is looking.
      if (event.shiftKey) arrangement.pasteAtPointer();
      else arrangement.paste();
    } else if (event.key === 'a' || event.key === 'A') {
      // Only hijack Select All in select mode; drop mode keeps browser behaviour.
      if (arrangement.timelineMode !== 'select') return;
      event.preventDefault();
      arrangement.selectAll();
    }
  });

  /* Bare-letter shortcuts. */
  window.addEventListener('keydown', (event) => {
    if (isTextEntry(event.target)) return;
    // Bare-letter shortcuts must not fire as Ctrl/Cmd combos: Ctrl+C copies
    // clips, but it also used to toggle the camera via the `c` shortcut.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      deps.seekBy(event.key === 'ArrowRight' ? 1 : -1, event.shiftKey);
    } else if (event.key === 'd' || event.key === 'D') {
      deps.applyTimelineMode('drop');
    } else if (event.key === 's' || event.key === 'S') {
      deps.applyTimelineMode('select');
    } else if (event.key === 'Escape') {
      if (ui.hint.open) ui.hint.open = false;
      else arrangement.clearSelection();
    } else if (event.key === '?') {
      ui.hint.open = !ui.hint.open;
    } else if (event.key === 'm' || event.key === 'M') {
      deps.toggleMute();
    } else if (event.key === 'x' || event.key === 'X') {
      deps.toggleStats();
    } else if (event.key === '`' || event.key === '~') {
      deps.toggleControls();
    } else if (event.key === 'l' || event.key === 'L') {
      deps.clearLoop();
    } else if (event.key === 'c' || event.key === 'C') {
      stage.nextView();
    } else if (event.key === 'o' || event.key === 'O') {
      stage.toggleOrbit();
    } else if (event.key === 'h' || event.key === 'H') {
      /* Cycle haze: clear → light → club → heavy, so the beam/pool balance can
       * be compared without opening the panel. */
      const next = [0, 0.3, 0.65, 1].find((value) => value > stage.hazeLevel + 0.01) ?? 0;
      stage.setHaze(next);
      syncButtons();
    } else if (event.key === 'g' || event.key === 'G') {
      post.setGrain(!post.grain);
      syncButtons();
    } else if (event.key === 'a' || event.key === 'A') {
      stage.toggleAudience();
      syncButtons();
    }
    syncButtons();
  });

  // Browsers map Ctrl+S/Cmd+S to "save page"; take it over so the app saves the
  // project instead, including while a text field has focus.
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key !== 's' && event.key !== 'S') return;
    event.preventDefault();
    if (!event.repeat) deps.saveProject();
  });
}
