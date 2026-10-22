import {
  defaultLedLook,
  type LedLookState,
  type LedMediaRef,
} from '@dmxsim/show-model';
import type { Arrangement } from '../arrangement';
import {
  LOOK_DEFINITIONS,
  PALETTE_PRESETS,
  lookDefinition,
} from '../led/look-definitions';
import {
  BUNDLED_MEDIA,
  mediaPoster,
  mediaRef,
  type LedMediaAsset,
  type LedMediaLibrary,
} from '../led/media';
import type { UiElements } from './elements';
import { enhanceSlider, parseNumericText } from './slider';

export interface LookEditorDeps {
  ui: UiElements;
  arrangement: Arrangement;
  /** Bundled and uploaded wall media, shared with the renderer. */
  media: LedMediaLibrary;
}

/** The popover shows one section at a time so it never needs a scrollbar. */
type LookEditorTab = 'look' | 'choose' | 'upload';

/**
 * The LED wall look editor: generator tiles, each generator's parameters, the
 * media gallery, and uploads.
 *
 * Self-contained: it wires its own button, popover and document dismissal, so
 * the app only has to construct it. It reads the current look from
 * `arrangement` on every interaction rather than caching one.
 */
export function installLookEditor(deps: LookEditorDeps): void {
  const { ui, arrangement, media } = deps;

  /** A surface is the current target when its lane or one of its clips is selected. */
  const surfaceTargeted = (): boolean =>
    arrangement.selectedSurface !== null || arrangement.selectedCue?.surfaceId !== undefined;

  const currentLook = (): LedLookState | null =>
    surfaceTargeted() ? arrangement.selectedLook ?? arrangement.suggestedLook : null;

  let lookEditorTab: LookEditorTab = 'look';

  /** Uploaded assets are read from IndexedDB once per session. */
  let localMediaAssets: LedMediaAsset[] = [];
  let localMediaRequested = false;
  /** Shown in the Upload tab when a dropped file is not image or video. */
  let mediaNotice = '';

  const setLookEditorTab = (tab: LookEditorTab): void => {
    lookEditorTab = tab;
    ui.lookTabLook.setAttribute('aria-selected', String(tab === 'look'));
    ui.lookTabChoose.setAttribute('aria-selected', String(tab === 'choose'));
    ui.lookTabUpload.setAttribute('aria-selected', String(tab === 'upload'));
    ui.lookPanelLook.hidden = tab !== 'look';
    ui.lookPanelChoose.hidden = tab !== 'choose';
    ui.lookPanelUpload.hidden = tab !== 'upload';
    // The footer belongs to the media tabs, and only once a clip is selected.
    ui.lookMediaFooter.hidden = tab === 'look' || currentLook()?.media === undefined;
  };

  const patchLook = (patch: Partial<LedLookState>): void => {
    const look = currentLook();
    if (look === null) return;
    arrangement.setSelectedLook({ ...look, ...patch });
    if (!ui.lookEditor.hidden) renderLookEditor();
  };

  const formatParam = (key: string, value: number, unit?: string): string => {
    if (key === 'intensity' || key === 'softness') return `${Math.round(value * 100)}%`;
    if (key === 'speed') {
      const sync = currentLook()?.sync;
      const syncUnit = sync === 'beat' ? 'cycles/beat' : sync === 'bar' ? 'cycles/bar' : 'Hz';
      return `${value.toFixed(2)} ${syncUnit}`;
    }
    return `${value.toFixed(key === 'scale' ? 2 : 0)}${unit ?? ''}`;
  };

  const ensureLocalMedia = (): void => {
    if (localMediaRequested) return;
    localMediaRequested = true;
    void media.listLocalAssets().then((assets) => {
      localMediaAssets = assets;
      if (!ui.lookEditor.hidden) {
        const look = currentLook();
        if (look !== null) renderMediaTabs(look);
      }
    }).catch((error: unknown) => {
      console.warn('could not list uploaded wall media', error);
    });
  };

  /** Replace the selected look with a media look using `asset`. */
  const applyMediaLook = (asset: LedMediaAsset): void => {
    const look = currentLook();
    const fit = look?.media?.fit ?? 'cover';
    mediaNotice = '';
    arrangement.setSelectedLook({ ...defaultLedLook('media'), media: mediaRef(asset, fit) });
    setLookEditorTab(asset.source.startsWith('local:') ? 'upload' : 'choose');
    renderLookEditor();
  };

  const mediaKindLabel = (kind: LedMediaAsset['kind']): string =>
    kind === 'video' ? 'Video' : 'Image';

  /** One gallery tile: a cached poster frame plus the asset label. */
  function mediaTile(
    asset: LedMediaAsset,
    selectedSource: string | undefined,
    onPick: (asset: LedMediaAsset) => void,
  ): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'le-media-tile';
    button.title = `${asset.label} · ${mediaKindLabel(asset.kind)}`;
    button.setAttribute('aria-pressed', String(selectedSource === asset.source));

    const frame = document.createElement('span');
    frame.className = 'le-media-frame';
    frame.textContent = asset.kind === 'video' ? '▶' : '▣';
    void mediaPoster(asset).then((src) => {
      if (src === '' || !button.isConnected) return;
      const image = document.createElement('img');
      image.src = src;
      image.alt = '';
      image.draggable = false;
      frame.replaceChildren(image);
      if (asset.kind === 'video') {
        const badge = document.createElement('b');
        badge.textContent = '▶';
        frame.appendChild(badge);
      }
    });

    const label = document.createElement('span');
    // Every bundled clip is a Mantissa loop, so the prefix is noise in a narrow
    // tile. Keep the full name in the tooltip.
    label.textContent = asset.source.startsWith('bundled:')
      ? asset.label.replace(/^Mantissa\s+/i, 'Loop ')
      : asset.label;
    button.append(frame, label);
    button.addEventListener('click', () => onPick(asset));
    return button;
  }

  /**
   * Gallery + current-selection footer for the Choose and Upload tabs.
   *
   * Thumbnails are cached poster frames rather than live `<video>` tiles: ten
   * decoders (and a new burst on every re-render) made the popover stutter and
   * filled the console with aborted requests.
   */
  function renderMediaTabs(look: LedLookState): void {
    ensureLocalMedia();
    const selected = look.kind === 'media' ? look.media : undefined;
    const selectedSource = selected?.source;
    const pick = (asset: LedMediaAsset): void => applyMediaLook(asset);

    ui.lookChooseGrid.replaceChildren(...BUNDLED_MEDIA.map((asset) => mediaTile(asset, selectedSource, pick)));
    ui.lookUploadGrid.replaceChildren(...localMediaAssets.map((asset) => mediaTile(asset, selectedSource, pick)));
    ui.lookUploadEmpty.hidden = localMediaAssets.length > 0 || mediaNotice === '';
    ui.lookUploadEmpty.textContent = mediaNotice !== ''
      ? mediaNotice
      : 'Nothing uploaded yet.';

    const isMedia = selected !== undefined;
    ui.lookMediaFooter.hidden = !isMedia || lookEditorTab === 'look';
    if (!isMedia) return;
    const local = selected.source.startsWith('local:');
    ui.lookMediaCurrent.replaceChildren();
    const name = document.createElement('b');
    name.textContent = selected.label ?? selected.source;
    const origin = document.createElement('em');
    origin.textContent = ` · ${mediaKindLabel(selected.kind)} · ${local ? 'upload' : 'bundled'}`;
    ui.lookMediaCurrent.append(name, origin);
    ui.lookMediaFit.value = selected.fit;
    ui.lookMediaRemove.hidden = !local;
  }

  /** Rebuild the popover from the current look and its generator's param list. */
  function renderLookEditor(): void {
    const look = currentLook();
    if (look === null) return;
    setLookEditorTab(lookEditorTab);
    const definition = lookDefinition(look.kind);
    ui.lookGlyph.textContent = definition.glyph;
    ui.lookTitle.textContent = definition.label;
    ui.lookGrid.replaceChildren(...LOOK_DEFINITIONS.map((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'le-tile';
      button.setAttribute('aria-pressed', String(entry.kind === look.kind));
      button.title = entry.hint;
      button.innerHTML = `<b>${entry.glyph}</b><span>${entry.label}</span>`;
      button.addEventListener('click', () => {
        arrangement.setPendingLookKind(entry.kind);
        arrangement.setSelectedLook({ ...defaultLedLook(entry.kind), colors: [...look.colors] });
        renderLookEditor();
      });
      return button;
    }));

    const controls = definition.params.map((param) => {
      if (param.kind === 'palette') {
        const field = document.createElement('label');
        field.className = 'le-field';
        field.innerHTML = `<span>${param.label}</span>`;
        const row = document.createElement('div');
        row.className = 'le-colors';
        for (const [index, css] of look.colors.entries()) {
          const input = document.createElement('input');
          input.type = 'color';
          input.value = css;
          input.setAttribute('aria-label', `Colour ${index + 1}`);
          input.addEventListener('change', () => {
            const colors = [...look.colors];
            colors[index] = input.value;
            patchLook({ colors });
          });
          row.appendChild(input);
        }
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'le-add';
        add.textContent = '+';
        add.title = 'Add a colour stop';
        add.disabled = look.colors.length >= param.max;
        add.addEventListener('click', () => {
          patchLook({ colors: [...look.colors, look.colors.at(-1) ?? '#ffffff'] });
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'le-add';
        remove.textContent = '−';
        remove.title = 'Remove the last colour stop';
        remove.disabled = look.colors.length <= param.min;
        remove.addEventListener('click', () => {
          patchLook({ colors: look.colors.slice(0, -1) });
        });
        row.append(add, remove);
        field.appendChild(row);
        return field;
      }
      if (param.kind === 'seed') {
        const field = document.createElement('label');
        field.className = 'le-field';
        field.innerHTML = `<span>${param.label}</span>`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sp-btn';
        button.textContent = `Randomise (${Math.round(look.seed)})`;
        button.addEventListener('click', () => patchLook({ seed: Math.random() * 1000 }));
        field.appendChild(button);
        return field;
      }
      if (param.kind === 'select') {
        const field = document.createElement('label');
        field.className = 'le-field';
        field.innerHTML = `<span>${param.label}</span>`;
        const select = document.createElement('select');
        select.className = 'le-select';
        for (const option of param.options) {
          const element = document.createElement('option');
          element.value = option.value;
          element.textContent = option.label;
          select.appendChild(element);
        }
        select.value = look.sync;
        select.addEventListener('change', () => patchLook({ sync: select.value as LedLookState['sync'] }));
        field.appendChild(select);
        return field;
      }
      const field = document.createElement('label');
      field.className = 'le-field';
      const value = look[param.key];
      field.innerHTML = `<span>${param.label}</span><output>${formatParam(param.key, value, param.unit)}</output>`;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(param.min);
      input.max = String(param.max);
      input.step = String(param.step);
      input.value = String(value);
      input.setAttribute('aria-label', param.label);
      const readout = field.querySelector<HTMLElement>('output')!;
      // Intensity and softness are 0..1 numbers shown as percentages.
      const percentParam = param.key === 'intensity' || param.key === 'softness';
      enhanceSlider(input, readout, {
        beforeEdit: () => arrangement.beginLookEdit(),
        ...(percentParam
          ? {
              parse: (text) => {
                const numeric = parseNumericText(text);
                return numeric === null ? null : numeric / 100;
              },
            }
          : {}),
      });
      input.addEventListener('pointerdown', () => arrangement.beginLookEdit());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
          || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          arrangement.beginLookEdit();
        }
      });
      input.addEventListener('input', () => {
        const numeric = Number(input.value);
        field.querySelector('output')!.textContent = formatParam(param.key, numeric, param.unit);
        const target = currentLook();
        if (target === null) return;
        arrangement.previewSelectedLook({ ...target, [param.key]: numeric });
      });
      input.addEventListener('change', () => arrangement.commitLookEdit());
      field.appendChild(input);
      return field;
    });
    ui.lookControls.replaceChildren(...controls);

    ui.lookPresets.replaceChildren(...PALETTE_PRESETS.map((preset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'le-preset';
      button.title = preset.name;
      button.style.background = `linear-gradient(90deg, ${preset.colors.join(', ')})`;
      button.addEventListener('click', () => patchLook({ colors: [...preset.colors] }));
      return button;
    }));

    renderMediaTabs(look);
  }

  /** Import files from the upload button or a drop and select the first one. */
  function importWallMedia(files: File[]): void {
    if (files.length === 0) return;
    void media.importFiles(files).then((refs) => {
      const first = refs[0];
      if (first === undefined) {
        mediaNotice = 'Only image and video files can be used on the wall.';
        setLookEditorTab('upload');
        renderLookEditor();
        return;
      }
      mediaNotice = '';
      // Force the library to re-list so the new uploads appear in the gallery.
      localMediaAssets = [];
      localMediaRequested = false;
      arrangement.setSelectedLook({ ...defaultLedLook('media'), media: first });
      setLookEditorTab('upload');
      renderLookEditor();
    }).catch((error: unknown) => {
      console.warn('could not import wall media', error);
    });
  }

  function open(): void {
    if (!surfaceTargeted()) return;
    const look = currentLook();
    lookEditorTab = look?.kind !== 'media'
      ? 'look'
      : look.media?.source.startsWith('local:') ? 'upload' : 'choose';
    renderLookEditor();
    ui.lookEditor.hidden = false;
    ui.lookEdit.setAttribute('aria-expanded', 'true');
  }

  function close(): void {
    if (ui.lookEditor.hidden) return;
    ui.lookEditor.hidden = true;
    ui.lookEdit.removeAttribute('aria-expanded');
  }

  ui.lookTabLook.addEventListener('click', () => setLookEditorTab('look'));
  ui.lookTabChoose.addEventListener('click', () => setLookEditorTab('choose'));
  ui.lookTabUpload.addEventListener('click', () => setLookEditorTab('upload'));

  ui.lookMediaFit.addEventListener('change', () => {
    const look = currentLook();
    if (look?.media === undefined) return;
    patchLook({ media: { ...look.media, fit: ui.lookMediaFit.value as LedMediaRef['fit'] } });
  });

  ui.lookMediaRemove.addEventListener('click', () => {
    const look = currentLook();
    if (look?.media === undefined) return;
    const source = look.media.source;
    void media.removeAsset(source).then(() => {
      localMediaAssets = [];
      localMediaRequested = false;
      const current = currentLook();
      if (current?.kind === 'media' && current.media?.source === source) {
        arrangement.setSelectedLook({ ...defaultLedLook('gradient'), colors: [...current.colors] });
      }
      renderLookEditor();
    });
  });

  ui.lookUpload.addEventListener('click', () => ui.lookFile.click());
  ui.lookFile.addEventListener('change', () => {
    const files = [...(ui.lookFile.files ?? [])];
    ui.lookFile.value = '';
    importWallMedia(files);
  });
  ui.lookPanelUpload.addEventListener('dragover', (event) => {
    event.preventDefault();
    ui.lookPanelUpload.classList.add('dragging');
  });
  ui.lookPanelUpload.addEventListener('dragleave', () => {
    ui.lookPanelUpload.classList.remove('dragging');
  });
  ui.lookPanelUpload.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.lookPanelUpload.classList.remove('dragging');
    importWallMedia([...(event.dataTransfer?.files ?? [])]);
  });

  ui.lookEdit.addEventListener('click', () => {
    if (ui.lookEditor.hidden) open();
    else close();
  });
  ui.lookClose.addEventListener('click', () => {
    close();
    ui.lookEdit.focus();
  });
  ui.lookEditor.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    ui.lookEdit.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (ui.lookEditor.hidden || !(target instanceof Node)) return;
    if (ui.lookEditor.contains(target) || ui.lookEdit.contains(target)) return;
    close();
  });
}
