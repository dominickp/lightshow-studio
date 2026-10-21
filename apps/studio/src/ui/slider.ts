/**
 * Slider ergonomics without extra chrome.
 *
 * Dragging a range input snaps to a coarse increment (about 5% of its range by
 * default) so values land on round numbers instead of wherever the pointer
 * happens to stop. The text readout next to the slider doubles as an editor:
 * click it, type an exact number, press Enter. Arrow keys still move by the
 * input's native `step`, so fine adjustment is available without any new
 * controls.
 */

/** Coarse steps round to 1, 2 or 5 times a power of ten. */
const NICE_FACTORS = [1, 2, 5, 10] as const;

/** Round `raw` up to the nearest "round" number (`5`, `20`, `0.2`, …). */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = NICE_FACTORS.find((candidate) => normalized <= candidate + 1e-9) ?? 10;
  return factor * magnitude;
}

/** Default drag increment: ~5% of the track, but never finer than `step`. */
function defaultSnap(input: HTMLInputElement): number {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const native = Number(input.step) || 1;
  return Math.max(native, niceStep((max - min) * 0.05));
}

export interface EnhanceSliderOptions {
  /** Override the drag increment; `1` disables coarse snapping. */
  snap?: number;
  /**
   * Read a typed readout back as a slider value. Defaults to the first number
   * in the text, so `"13.5 m"`, `"±189°"` and `"0.04 s"` all work. Pass one
   * when the readout is not in the slider's own units (percent vs. 0..1).
   */
  parse?: (text: string) => number | null;
  /** Runs just before an edited value is applied, e.g. to open an undo step. */
  beforeEdit?: () => void;
}

/** First number in `text`, tolerating units, `±` and typographic minus. */
export function parseNumericText(text: string): number | null {
  const cleaned = text.replace(/[−–—]/g, '-').replace(/±/g, '');
  const match = cleaned.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
  if (match === null) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

const clampToInput = (input: HTMLInputElement, value: number): number => {
  const min = Number(input.min);
  const max = Number(input.max);
  const lower = Number.isFinite(min) ? min : -Infinity;
  const upper = Number.isFinite(max) ? max : Infinity;
  return Math.min(upper, Math.max(lower, value));
};

/** Write a value through the input and let existing listeners react to it. */
const applyValue = (
  input: HTMLInputElement,
  value: number,
  beforeEdit?: () => void,
): void => {
  const next = clampToInput(input, value);
  // Keep float dust out of what the rest of the app stores.
  input.value = String(Number(next.toFixed(6)));
  beforeEdit?.();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

const selectContents = (element: HTMLElement): void => {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

/** Turn the readout into a click-to-type field for exact values. */
function makeReadoutEditable(
  input: HTMLInputElement,
  output: HTMLElement,
  options: EnhanceSliderOptions,
): void {
  const parse = options.parse ?? parseNumericText;
  let originalText = '';
  let cancelled = false;
  let editing = false;
  /** Latest text the app wanted to show, applied again once editing ends. */
  let pendingText = '';

  output.contentEditable = 'true';
  output.spellcheck = false;
  output.tabIndex = 0;
  output.classList.add('value-editable');
  output.title = output.title || 'Click to type an exact value';
  output.setAttribute('role', 'textbox');
  // Reuse the slider's own label; the readout has no text label of its own.
  const labelledBy = input.getAttribute('aria-labelledby');
  const labelText = labelledBy === null ? null : document.getElementById(labelledBy)?.textContent;
  const label = input.getAttribute('aria-label') ?? labelText ?? 'Value';
  output.setAttribute('aria-label', `${label}, editable`);

  // Syncers run every frame (playback, render controls). While the readout is
  // being typed into, hold their writes back so they cannot eat the keystrokes.
  const nodeText = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  const plainText = (): string => (nodeText?.get?.call(output) as string | undefined) ?? '';
  const setPlainText = (text: string): void => {
    nodeText?.set?.call(output, text);
  };
  if (nodeText?.get !== undefined && nodeText.set !== undefined) {
    Object.defineProperty(output, 'textContent', {
      configurable: true,
      get: plainText,
      set: (value: string) => {
        pendingText = value;
        if (!editing) setPlainText(value);
      },
    });
  }

  const restore = (): void => {
    editing = false;
    setPlainText(originalText);
  };

  const commit = (): void => {
    const typed = parse(plainText());
    editing = false;
    if (cancelled || typed === null) {
      cancelled = false;
      restore();
      return;
    }
    // No-op edits should not open an undo step or re-render the show.
    if (clampToInput(input, typed) === Number(input.value)) {
      restore();
      return;
    }
    applyValue(input, typed, options.beforeEdit);
    // Listeners normally re-render the readout during `applyValue`; fall back
    // to the pending text when this readout has no such handler.
    if (plainText() === '' && pendingText !== '') setPlainText(pendingText);
  };

  // Inside a <label> a click would otherwise focus/activate the range input.
  output.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (document.activeElement !== output) output.focus();
    selectContents(output);
  });
  output.addEventListener('click', (event) => event.preventDefault());

  output.addEventListener('focus', () => {
    cancelled = false;
    editing = true;
    originalText = plainText();
    selectContents(output);
  });

  output.addEventListener('blur', commit);

  output.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      output.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelled = true;
      output.blur();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = (Number(input.step) || 1) * (event.shiftKey ? 10 : 1);
    applyValue(input, Number(input.value) + (event.key === 'ArrowUp' ? step : -step), options.beforeEdit);
    // Sync writes were held back; show the newly formatted value and keep the
    // caret in the field so the next arrow press still works.
    setPlainText(pendingText);
    selectContents(output);
  });

  output.addEventListener('paste', (event) => {
    // Keep the field single-line and free of rich text.
    event.preventDefault();
    const text = event.clipboardData?.getData('text') ?? '';
    document.execCommand('insertText', false, text.replace(/\s+/g, ' ').trim());
  });
}

/**
 * Make one range input easier to land on:
 * pointer drags snap, the readout can be typed into, arrows stay fine-grained.
 */
export function enhanceSlider(
  input: HTMLInputElement,
  output?: HTMLElement | null,
  options: EnhanceSliderOptions = {},
): void {
  let dragging = false;
  input.addEventListener('pointerdown', () => {
    dragging = true;
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
  });

  // Capture phase: the snapping happens before the slider's own `input`
  // listener reads the value, whichever order the two were registered in.
  input.addEventListener(
    'input',
    () => {
      if (!dragging) return;
      const min = Number(input.min) || 0;
      const step = options.snap ?? defaultSnap(input);
      const value = Number(input.value);
      const snapped = min + Math.round((value - min) / step) * step;
      const next = Number(snapped.toFixed(6));
      if (next !== value) input.value = String(next);
    },
    { capture: true },
  );

  if (output !== undefined && output !== null) {
    makeReadoutEditable(input, output, options);
  }
}
