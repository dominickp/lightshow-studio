import { CUE_COLORS } from '../arrangement/colors';
import type { Arrangement } from '../arrangement';
import type { CueColorOverride } from '../arrangement/types';
import { kelvinToCss, kelvinToRgb } from '../kelvin';
import { STORAGE_KEYS, readPreference, writePreference } from './preferences';
import type { UiElements } from './elements';

export interface ColorPickerDeps {
  ui: UiElements;
  arrangement: Arrangement;
}

export interface ColorPicker {
  /** Reflect the selected color on the bar swatch and, if open, the popover. */
  sync(selectedIndex: number, override: CueColorOverride | undefined, enabled: boolean): void;
  /** Close the popover without resetting the selection. */
  close(): void;
}

/**
 * Recent colors learned from custom picks, shown as a row inside the picker
 * popover (most recent first) so frequent custom colors become one click.
 * Persisted per browser.
 */
const USER_COLORS_KEY = STORAGE_KEYS.userColors;
const USER_COLORS_MAX = 7;

/** CSS for an override, used by the swatch, preview and hex field. */
const toHexByte = (value: number): string =>
  Math.round(value * 255).toString(16).padStart(2, '0');

const colorOverrideCss = (override: CueColorOverride): string => {
  if (override.kind === 'white') return kelvinToCss(override.cct);
  return `#${toHexByte(override.r)}${toHexByte(override.g)}${toHexByte(override.b)}`;
};

const sameColor = (a: CueColorOverride, b: CueColorOverride): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const loadUserColors = (): CueColorOverride[] => {
  try {
    const raw = readPreference(USER_COLORS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CueColorOverride => {
      if (typeof item !== 'object' || item === null) return false;
      const c = item as Record<string, unknown>;
      return (c.kind === 'rgb' && ['r', 'g', 'b'].every((k) => typeof c[k] === 'number'))
        || (c.kind === 'white' && typeof c.cct === 'number');
    }).slice(0, USER_COLORS_MAX);
  } catch {
    return [];
  }
};

/** Hex string (`#rrggbb`) to a 0..1 rgb override. */
const parseHex = (value: string): CueColorOverride | null => {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) return null;
  const hex = match[1]!;
  return {
    kind: 'rgb',
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
};

/** Quick swatches compute to `rgb(...)`; normalise to hex for the override. */
const rgbTextToHex = (text: string): string => {
  const [r, g, b] = text.match(/\d+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
};

/** Which color the bar's current swatch reflects, with its label. */
type CurrentColor = { override?: CueColorOverride; colorIndex: number; label: string };

/**
 * The clip colour control: a one-row bar with the current swatch and a picker
 * button, plus the popover that holds the palette, recent colours and the
 * browser's own HSV picker.
 *
 * The bar deliberately keeps only two buttons so it never wraps as the user
 * collects colours; everything else lives in the popover.
 */
export function createColorPicker(deps: ColorPickerDeps): ColorPicker {
  const { ui, arrangement } = deps;

  const currentSwatch = document.createElement('button');
  currentSwatch.type = 'button';
  currentSwatch.className = 'color-swatch current';
  currentSwatch.style.setProperty('--swatch', CUE_COLORS[0]!.css);
  currentSwatch.setAttribute('role', 'radio');
  currentSwatch.setAttribute('aria-checked', 'true');
  currentSwatch.setAttribute('aria-label', 'Current clip color');
  currentSwatch.disabled = true;
  currentSwatch.tabIndex = -1;
  currentSwatch.title = CUE_COLORS[0]!.name;

  const CUSTOM_COLOR_INDEX = CUE_COLORS.length;

  const customSwatch = document.createElement('button');
  customSwatch.type = 'button';
  customSwatch.className = 'color-swatch custom';
  customSwatch.dataset.colorIndex = String(CUSTOM_COLOR_INDEX);
  customSwatch.title = 'Custom color…';
  customSwatch.setAttribute('role', 'radio');
  customSwatch.setAttribute('aria-label', 'Custom color');
  customSwatch.setAttribute('aria-checked', 'false');
  customSwatch.setAttribute('aria-haspopup', 'dialog');
  customSwatch.disabled = true;
  customSwatch.tabIndex = -1;

  let userColors: CueColorOverride[] = loadUserColors();

  const paletteSwatches: HTMLButtonElement[] = CUE_COLORS.map((color, index) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    swatch.dataset.colorIndex = String(index);
    swatch.style.setProperty('--swatch', color.css);
    swatch.title = color.name[0]!.toUpperCase() + color.name.slice(1);
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-label', `${swatch.title} color`);
    swatch.setAttribute('aria-checked', 'false');
    swatch.tabIndex = -1;
    return swatch;
  });

  ui.cueColor.replaceChildren(currentSwatch, customSwatch);

  const userSwatches: HTMLButtonElement[] = [];
  const renderUserSwatches = (): void => {
    userSwatches.length = 0;
    for (const [index, override] of userColors.entries()) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'color-swatch user';
      swatch.dataset.userIndex = String(index);
      swatch.style.setProperty('--swatch', colorOverrideCss(override));
      swatch.title = override.kind === 'white'
        ? `White · ${Math.round(override.cct)} K`
        : colorOverrideCss(override).toUpperCase();
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-label', `Recent color ${index + 1}: ${swatch.title}`);
      swatch.setAttribute('aria-checked', 'false');
      swatch.tabIndex = -1;
      userSwatches.push(swatch);
    }
    ui.colorPalette.replaceChildren(...paletteSwatches, ...userSwatches);
  };
  renderUserSwatches();

  const rememberUserColor = (override: CueColorOverride): void => {
    userColors = [override, ...userColors.filter((c) => !sameColor(c, override))].slice(0, USER_COLORS_MAX);
    writePreference(USER_COLORS_KEY, JSON.stringify(userColors));
    renderUserSwatches();
  };

  let currentColor: CurrentColor = { colorIndex: 0, label: CUE_COLORS[0]!.name };

  /** Keep the popover's preview and color input in step with the override. */
  function syncColorPicker(override: CueColorOverride | undefined): void {
    const css = override === undefined ? undefined : colorOverrideCss(override);
    ui.colorPreview.style.background = css ?? 'conic-gradient(#ff2f2f, #ff8a18, #16d9cc, #397cff, #8c35ff, #ff3380, #ff2f2f)';
    if (override?.kind === 'rgb') ui.colorInput.value = css!.toUpperCase();
  }

  function sync(
    selectedIndex: number,
    override: CueColorOverride | undefined,
    enabled: boolean,
  ): void {
    ui.cueColor.dataset.disabled = String(!enabled);
    const selected = Math.min(Math.max(0, selectedIndex), CUE_COLORS.length - 1);
    const userIndex = override === undefined ? -1 : userColors.findIndex((c) => sameColor(c, override));
    for (const [index, swatch] of paletteSwatches.entries()) {
      const isSelected = override === undefined && index === selected;
      swatch.classList.toggle('selected', isSelected);
      swatch.setAttribute('aria-checked', String(isSelected));
    }
    for (const [index, swatch] of userSwatches.entries()) {
      const isSelected = index === userIndex;
      swatch.classList.toggle('selected', isSelected);
      swatch.setAttribute('aria-checked', String(isSelected));
    }
    const customSelected = override !== undefined && userIndex === -1;
    customSwatch.classList.toggle('selected', customSelected);
    customSwatch.setAttribute('aria-checked', String(customSelected));
    if (override === undefined || userIndex !== -1) {
      customSwatch.removeAttribute('data-has-custom');
      customSwatch.removeAttribute('style');
      customSwatch.title = 'Custom color…';
    } else {
      const css = colorOverrideCss(override);
      customSwatch.dataset.hasCustom = 'true';
      customSwatch.style.setProperty('--swatch', css);
      customSwatch.title = override.kind === 'white'
        ? `Custom white · ${Math.round(override.cct)} K`
        : `Custom color · ${css.toUpperCase()}`;
    }
    // The bar's current swatch always mirrors what a new/selected clip uses.
    currentColor = override === undefined
      ? { colorIndex: selected, label: CUE_COLORS[selected]!.name }
      : { override, colorIndex: CUSTOM_COLOR_INDEX, label: customSwatch.title };
    const [cr, cg, cb] = override === undefined
      ? CUE_COLORS[selected]!.rgb
      : override.kind === 'rgb'
        ? [override.r, override.g, override.b]
        : kelvinToRgb(override.cct);
    currentSwatch.style.setProperty('--swatch', `#${toHexByte(cr)}${toHexByte(cg)}${toHexByte(cb)}`);
    currentSwatch.title = currentColor.label;
    currentSwatch.disabled = !enabled;
    customSwatch.disabled = !enabled;
    currentSwatch.tabIndex = enabled ? 0 : -1;
    customSwatch.tabIndex = enabled ? 0 : -1;
    if (!ui.colorPicker.hidden) syncColorPicker(override);
  }

  const chooseColor = (colorIndex: number, override?: CueColorOverride): void => {
    arrangement.setPendingColor(colorIndex, override);
    arrangement.setSelectedColor(colorIndex, override);
  };

  function open(): void {
    if (customSwatch.disabled) return;
    if (!ui.colorPicker.hidden) return;
    const selected = arrangement.selectedCue ?? null;
    const override = selected?.colorOverride ?? arrangement.suggestedColorOverride ?? undefined;
    syncColorPicker(override);
    ui.colorPicker.hidden = false;
    customSwatch.setAttribute('aria-expanded', 'true');
    ui.colorInput.focus();
  }

  function close(): void {
    if (ui.colorPicker.hidden) return;
    ui.colorPicker.hidden = true;
    customSwatch.removeAttribute('aria-expanded');
  }

  const applyHex = (hex: string): void => {
    const override = parseHex(hex);
    if (override === null) return;
    rememberUserColor(override);
    chooseColor(CUSTOM_COLOR_INDEX, override);
  };

  // The bar's current swatch opens the picker (it doubles as the palette entry
  // point); the custom swatch does too, and clicking either one again closes it.
  ui.cueColor.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.color-swatch');
    if (target === null || target.hasAttribute('disabled')) return;
    if (ui.colorPicker.hidden) open();
    else close();
  });

  ui.colorPalette.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.color-swatch');
    if (target === null) return;
    const userIndex = target.dataset.userIndex;
    if (userIndex !== undefined) {
      const override = userColors[Number(userIndex)];
      if (override !== undefined) chooseColor(CUSTOM_COLOR_INDEX, override);
      return;
    }
    chooseColor(Number(target.dataset.colorIndex));
  });

  // Arrow keys move within the popover's palette, matching a select's keyboard
  // behaviour; Escape closes back to the bar.
  ui.colorPalette.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const list = [...paletteSwatches, ...userSwatches];
    const currentElement = list.find((swatch) => swatch.classList.contains('selected')) ?? list[0]!;
    const current = list.indexOf(currentElement);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = (current + step + list.length) % list.length;
    event.preventDefault();
    const target = list[next]!;
    const userIndex = target.dataset.userIndex;
    if (userIndex !== undefined) {
      const override = userColors[Number(userIndex)];
      if (override !== undefined) chooseColor(CUSTOM_COLOR_INDEX, override);
    } else {
      chooseColor(Number(target.dataset.colorIndex));
    }
    target.focus();
  });

  ui.colorPickerClose.addEventListener('click', () => {
    close();
    customSwatch.focus();
  });

  // Clicking elsewhere in the app dismisses the popover, as a menu would.
  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (ui.colorPicker.hidden || !(target instanceof Node)) return;
    if (ui.colorPicker.contains(target) || ui.cueColor.contains(target)) return;
    close();
  });

  ui.colorPicker.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    customSwatch.focus();
  });

  // The browser's HSV picker does the visual work. Dragging previews live but
  // only commits on `change`, so one pick is one undo step.
  ui.colorInput.addEventListener('input', () => {
    ui.colorPreview.style.background = ui.colorInput.value;
  });
  ui.colorInput.addEventListener('change', () => applyHex(ui.colorInput.value));
  ui.hueGrid.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (target === null) return;
    const hex = rgbTextToHex(getComputedStyle(target).backgroundColor);
    ui.colorInput.value = hex;
    applyHex(hex);
  });

  return { sync, close };
}
