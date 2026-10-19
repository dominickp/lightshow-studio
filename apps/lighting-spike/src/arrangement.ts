import type { Clip, FixturePlacement } from '@dmxsim/show-model';

export const CUE_COLORS = [
  { name: 'blue', css: '#397cff', rgb: [0.08, 0.35, 1] },
  { name: 'violet', css: '#8c35ff', rgb: [0.55, 0.08, 1] },
  { name: 'magenta', css: '#ff3380', rgb: [1, 0.1, 0.5] },
  { name: 'cyan', css: '#16d9cc', rgb: [0.05, 0.85, 0.8] },
  { name: 'amber', css: '#ff8a18', rgb: [1, 0.42, 0.05] },
  { name: 'red', css: '#ff2f2f', rgb: [1, 0.08, 0.08] },
  { name: 'white', css: '#f2f6ff', rgb: [1, 1, 1] },
] as const;

export type CueAction = 'hold' | 'fade' | 'pulse' | 'sweep' | 'strobe';

export interface Cue {
  id: string;
  fixtureId: string;
  startSec: number;
  endSec: number;
  colorIndex: number;
  action: CueAction;
  /** Overrides the default 40 ms fade-in when the cue starts (seconds). */
  fadeInSec?: number;
}

export interface CueTimeline {
  durationSec: number;
  firstBeatSec: number;
  bpm: number | null;
  beatsPerBar: number;
  /** Playback loop region, when the transport is looping. Clips outside it cannot play. */
  loopStartSec?: number;
  loopEndSec?: number;
}

export const PIXELS_PER_SECOND = 48;
export const MIN_PIXELS_PER_SECOND = 0.25;
export const MAX_PIXELS_PER_SECOND = 480;
export const TRACK_LABEL_WIDTH = 176;

/** Matches the `.fixture-row.hidden` opacity in index.html. */
const HIDDEN_ROW_OPACITY = 0.32;
const MIN_CLIP_SEC = 0.1;
const EDGE_GRAB_PX = 8;
const HISTORY_LIMIT = 100;

interface CueSnapshot {
  cues: Cue[];
  selectedCueId: string | null;
}

type Gesture =
  | { type: 'create'; fixtureId: string; startSec: number; currentSec: number }
  | { type: 'move'; cueId: string; startSec: number; initialStartSec: number; durationSec: number }
  | { type: 'resize'; cueId: string; edge: 'start' | 'end' };

export class Arrangement {
  private timeline: CueTimeline | null = null;
  private cues: Cue[] = [];
  private fixtures: FixturePlacement[];
  private selectedFixtureId: string | null = null;
  private selectedCueId: string | null = null;
  private readonly hiddenFixtureIds = new Set<string>();
  private gesture: Gesture | null = null;
  private gestureSnapshot: CueSnapshot | null = null;
  private readonly undoStack: CueSnapshot[] = [];
  private readonly redoStack: CueSnapshot[] = [];
  private nextId = 1;
  private songTime = 0;
  private pixelsPerSecond = PIXELS_PER_SECOND;
  private pendingAction: CueAction | null = null;
  private pendingColorIndex: number | null = null;
  private preview: { fixtureId: string; startSec: number; endSec: number } | null = null;
  private hoverGhost: HTMLElement | null = null;
  private playheadLine: HTMLElement | null = null;
  private clipElements: HTMLElement[] = [];
  private visibilityFrame = 0;
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private overlayFrame = 0;
  private hoveredCueId: string | null = null;
  private trackWidth = TRACK_LABEL_WIDTH;
  private rowsHeight = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly scroller: HTMLElement,
    fixtures: FixturePlacement[],
    private readonly onChange: (cues: readonly Cue[]) => void,
    private readonly onSelection: (fixture: FixturePlacement | null, cue: Cue | null) => void,
    private readonly onVisibilityChange?: (fixtureId: string, hidden: boolean) => void,
    /**
     * Fired when a track's name is clicked (after selection has been applied).
     * The shell uses it to toggle the fixture side panel without the
     * arrangement needing to know whether that panel is open.
     */
    private readonly onTrackName?: (fixture: FixturePlacement) => void,
  ) {
    this.fixtures = fixtures;
    const overlay = document.createElement('canvas');
    overlay.className = 'arrangement-clips';
    overlay.setAttribute('aria-hidden', 'true');
    const overlayCtx = overlay.getContext('2d');
    if (overlayCtx === null) throw new Error('2d canvas unavailable');
    this.overlay = overlay;
    this.overlayCtx = overlayCtx;
    this.root.appendChild(overlay);

    this.root.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.root.addEventListener('keydown', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('.track-visibility') === null) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const row = target.closest<HTMLElement>('.fixture-row');
      const fixtureId = row?.dataset.fixtureId;
      if (fixtureId !== undefined) this.toggleFixtureVisibility(fixtureId);
    });
    scroller.addEventListener('scroll', () => {
      this.scheduleClipVisibility();
      this.scheduleDraw();
    }, { passive: true });
    new ResizeObserver(() => {
      this.scheduleClipVisibility();
      this.scheduleDraw();
    }).observe(scroller);
    window.addEventListener('pointermove', (event) => this.pointerMove(event));
    window.addEventListener('pointerup', (event) => this.pointerUp(event));
    window.addEventListener('pointercancel', () => this.cancelGesture());
    this.root.addEventListener('pointermove', (event) => this.pointerHover(event));
    this.root.addEventListener('pointerleave', () => {
      this.hideHover();
      this.setHoveredCue(null);
    });
  }

  get selectedFixture(): FixturePlacement | null {
    return this.fixtures.find((fixture) => fixture.id === this.selectedFixtureId) ?? null;
  }

  isFixtureHidden(fixtureId: string): boolean {
    return this.hiddenFixtureIds.has(fixtureId);
  }

  get selectedCue(): Cue | null {
    return this.cues.find((cue) => cue.id === this.selectedCueId) ?? null;
  }

  get selectedActions(): CueAction[] {
    const fixture = this.selectedFixture;
    return fixture === null ? [] : this.actionsFor(fixture);
  }

  get suggestedAction(): CueAction {
    const fixture = this.selectedFixture;
    if (fixture === null) return this.pendingAction ?? 'hold';
    if (this.pendingAction !== null && this.actionsFor(fixture).includes(this.pendingAction)) {
      return this.pendingAction;
    }
    return this.defaultAction(fixture);
  }

  get suggestedColorIndex(): number {
    return this.pendingColorIndex ?? (this.cues.length % CUE_COLORS.length);
  }

  get zoomLevel(): number {
    return this.pixelsPerSecond;
  }

  setZoom(pixelsPerSecond: number): void {
    this.pixelsPerSecond = clamp(pixelsPerSecond, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND);
    this.renderRows();
  }

  setTimeline(timeline: CueTimeline): void {
    this.timeline = timeline;
    this.cues = [];
    this.selectedCueId = null;
    this.preview = null;
    this.clearHistory();
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** Replace the authored clips, e.g. with a seeded demo arrangement. */
  setCues(cues: readonly Cue[]): void {
    this.cues = cues.map((cue) => ({ ...cue }));
    this.cues = this.cues.filter((cue) => this.fixtures.some((fixture) => fixture.id === cue.fixtureId));
    this.selectedCueId = null;
    this.preview = null;
    this.clearHistory();
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** Revert the last clip edit (add, delete, move, resize, action or colour). */
  undo(): void {
    const previous = this.undoStack.pop();
    if (previous === undefined) return;
    this.redoStack.push(this.snapshot());
    this.restore(previous);
  }

  /** Re-apply the most recently undone clip edit. */
  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  /** Update the loop markers without clearing authored clips. */
  setLoop(startSec: number, endSec: number): void {
    if (this.timeline === null) return;
    this.timeline = { ...this.timeline, loopStartSec: startSec, loopEndSec: endSec };
    this.renderRows();
  }

  /**
   * One composited line covers every track. Moving 32 per-row playheads made
   * Firefox repaint the whole timeline layer on each frame.
   */
  setSongTime(songTime: number): void {
    this.songTime = songTime;
    if (this.playheadLine === null) {
      this.playheadLine = this.root.querySelector<HTMLElement>('.arrangement-playhead.global');
    }
    this.playheadLine?.style.setProperty(
      'transform',
      `translate3d(calc(var(--track-width) + ${this.songTime * this.pixelsPerSecond}px), 0, 0)`,
    );
  }

  selectFixture(fixtureId: string): void {
    if (!this.fixtures.some((fixture) => fixture.id === fixtureId)) return;
    this.selectedFixtureId = fixtureId;
    this.selectedCueId = null;
    this.renderRows();
    this.notifySelection();
  }

  addAt(songSec: number, action: CueAction): void {
    const fixture = this.selectedFixture;
    if (fixture === null || this.timeline === null) return;
    const startSec = this.snap(clamp(songSec, 0, this.timeline.durationSec - MIN_CLIP_SEC));
    this.createCue(fixture.id, startSec, action);
  }

  setSelectedAction(action: CueAction): void {
    const cue = this.selectedCue;
    const fixture = this.selectedFixture;
    if (cue === null || fixture === null || !this.actionsFor(fixture).includes(action)) return;
    this.pushHistory();
    this.cues = this.cues.map((item) => item.id === cue.id ? { ...item, action } : item);
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  setSelectedColor(colorIndex: number): void {
    const cue = this.selectedCue;
    if (cue === null || !this.selectedFixture?.profile.capabilities.color) return;
    this.pushHistory();
    this.cues = this.cues.map((item) => item.id === cue.id ? { ...item, colorIndex } : item);
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** The action used for the next clip when nothing is selected. */
  setPendingAction(action: CueAction): void {
    const fixture = this.selectedFixture;
    if (fixture === null || !this.actionsFor(fixture).includes(action)) return;
    this.pendingAction = action;
    this.notifySelection();
  }

  /** The colour used for the next clip when nothing is selected. */
  setPendingColor(colorIndex: number): void {
    if (!this.selectedFixture?.profile.capabilities.color) return;
    const count = CUE_COLORS.length;
    this.pendingColorIndex = ((colorIndex % count) + count) % count;
    this.notifySelection();
  }

  deleteSelected(): void {
    if (this.selectedCueId === null) return;
    this.pushHistory();
    this.cues = this.cues.filter((cue) => cue.id !== this.selectedCueId);
    this.selectedCueId = null;
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  private toggleFixtureVisibility(fixtureId: string): void {
    if (!this.fixtures.some((fixture) => fixture.id === fixtureId)) return;
    const hidden = !this.hiddenFixtureIds.has(fixtureId);
    if (hidden) this.hiddenFixtureIds.add(fixtureId);
    else this.hiddenFixtureIds.delete(fixtureId);
    this.renderRows();
    this.onVisibilityChange?.(fixtureId, hidden);
  }

  toClip(cue: Cue): Clip {
    return cueToClip(this.fixtures.find((item) => item.id === cue.fixtureId), cue);
  }

  private actionsFor(fixture: FixturePlacement): CueAction[] {
    const caps = fixture.profile.capabilities;
    return [
      'hold',
      'fade',
      'pulse',
      ...(caps.panTilt ? ['sweep' as const] : []),
      ...(caps.strobe ? ['strobe' as const] : []),
    ];
  }

  private pointerDown(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLElement>('.fixture-row');
    if (row === null) return;
    const fixtureId = row.dataset.fixtureId;
    if (fixtureId === undefined) return;
    if (target.closest('.track-visibility') !== null) {
      this.toggleFixtureVisibility(fixtureId);
      event.preventDefault();
      return;
    }
    this.selectedFixtureId = fixtureId;
    if (target.closest('.track-name') !== null) {
      this.selectedCueId = null;
      this.renderRows();
      // Announce the name click before the selection sync: the shell uses this
      // to decide whether to open, switch or close the fixture panel, and the
      // sync would otherwise overwrite the panel's previous fixture.
      const fixture = this.selectedFixture;
      if (fixture !== null) this.onTrackName?.(fixture);
      this.notifySelection();
      return;
    }
    const lane = target.closest<HTMLElement>('.fixture-lane');
    if (lane === null || this.timeline === null) return;

    const clipElement = target.closest<HTMLElement>('.arrangement-clip');
    if (clipElement !== null) {
      const cueId = clipElement.dataset.cueId;
      const cue = this.cues.find((item) => item.id === cueId);
      if (cue === undefined) return;
      this.selectedCueId = cue.id;
      const x = event.clientX - lane.getBoundingClientRect().left;
      const clipStartX = cue.startSec * this.pixelsPerSecond;
      const clipEndX = cue.endSec * this.pixelsPerSecond;
      const startHandle = target.closest('.clip-resize.start') !== null;
      const endHandle = target.closest('.clip-resize.end') !== null;
      if (startHandle || (!endHandle && Math.abs(x - clipStartX) <= EDGE_GRAB_PX)) {
        this.gesture = { type: 'resize', cueId: cue.id, edge: 'start' };
      } else if (endHandle || Math.abs(x - clipEndX) <= EDGE_GRAB_PX) {
        this.gesture = { type: 'resize', cueId: cue.id, edge: 'end' };
      } else {
        this.gesture = {
          type: 'move',
          cueId: cue.id,
          startSec: x / this.pixelsPerSecond,
          initialStartSec: cue.startSec,
          durationSec: cue.endSec - cue.startSec,
        };
      }
      this.gestureSnapshot = this.snapshot();
    } else {
      const time = this.snap(this.xToTime(event.clientX, lane));
      this.selectedCueId = null;
      this.gesture = { type: 'create', fixtureId, startSec: time, currentSec: time };
      this.gestureSnapshot = null;
      this.preview = { fixtureId, startSec: time, endSec: time + this.defaultLength() };
    }

    this.renderRows();
    this.notifySelection();
    event.preventDefault();
  }

  private pointerMove(event: PointerEvent): void {
    const gesture = this.gesture;
    if (gesture === null || this.timeline === null) return;
    if (gesture.type === 'create') {
      const lane = this.root.querySelector<HTMLElement>(`[data-fixture-id="${CSS.escape(gesture.fixtureId)}"] .fixture-lane`);
      if (lane === null) return;
      gesture.currentSec = this.snap(this.xToTime(event.clientX, lane));
      const start = Math.min(gesture.startSec, gesture.currentSec);
      const dragged = Math.max(gesture.startSec, gesture.currentSec);
      this.preview = {
        fixtureId: gesture.fixtureId,
        startSec: start,
        endSec: dragged - start >= MIN_CLIP_SEC ? dragged : start + this.defaultLength(),
      };
      this.scheduleDraw();
      return;
    }

    const cue = this.cues.find((item) => item.id === gesture.cueId);
    if (cue === undefined) return;
    const lane = this.root.querySelector<HTMLElement>(`[data-fixture-id="${CSS.escape(cue.fixtureId)}"] .fixture-lane`);
    if (lane === null) return;
    const time = this.snap(this.xToTime(event.clientX, lane));
    if (gesture.type === 'move') {
      const delta = time - gesture.startSec;
      const startSec = this.snap(clamp(
        gesture.initialStartSec + delta,
        0,
        Math.max(0, this.timeline.durationSec - gesture.durationSec),
      ));
      this.cues = this.cues.map((item) => item.id === cue.id
        ? { ...item, startSec, endSec: startSec + gesture.durationSec }
        : item);
    } else if (gesture.edge === 'end') {
      const endSec = clamp(time, cue.startSec + MIN_CLIP_SEC, this.timeline.durationSec);
      this.cues = this.cues.map((item) => item.id === cue.id ? { ...item, endSec } : item);
    } else {
      const startSec = clamp(time, 0, cue.endSec - MIN_CLIP_SEC);
      this.cues = this.cues.map((item) => item.id === cue.id ? { ...item, startSec } : item);
    }
    this.scheduleDraw();
  }

  private pointerUp(_event: PointerEvent): void {
    const gesture = this.gesture;
    if (gesture === null) return;
    this.gesture = null;
    const gestureSnapshot = this.gestureSnapshot;
    this.gestureSnapshot = null;
    this.preview = null;
    const timeline = this.timeline;
    if (timeline === null) return;
    if (gesture.type === 'create') {
      const startSec = Math.min(
        Math.min(gesture.startSec, gesture.currentSec),
        Math.max(0, timeline.durationSec - MIN_CLIP_SEC),
      );
      const dragEnd = Math.max(gesture.startSec, gesture.currentSec);
      const defaultEnd = startSec + this.defaultLength();
      const endSec = clamp(
        dragEnd - startSec >= MIN_CLIP_SEC ? dragEnd : defaultEnd,
        startSec + MIN_CLIP_SEC,
        timeline.durationSec,
      );
      if (endSec - startSec >= MIN_CLIP_SEC) {
        const row = this.fixtures.find((fixture) => fixture.id === gesture.fixtureId);
        const action = row === undefined ? 'hold' : this.defaultAction(row);
        this.createCue(gesture.fixtureId, startSec, action, endSec);
        return;
      }
    }
    // A move/resize drag only becomes an undo step when it actually changed a cue.
    if (gestureSnapshot !== null && !sameCues(gestureSnapshot.cues, this.cues)) {
      this.pushSnapshot(gestureSnapshot);
    }
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  private cancelGesture(): void {
    if (this.gesture === null) return;
    this.gesture = null;
    this.gestureSnapshot = null;
    this.preview = null;
    this.renderRows();
  }

  private createCue(fixtureId: string, startSec: number, action: CueAction, requestedEnd?: number): void {
    const duration = this.timeline?.durationSec ?? 0;
    const endSec = Math.min(duration, Math.max(startSec + MIN_CLIP_SEC, requestedEnd ?? startSec + this.defaultLength()));
    if (endSec - startSec < MIN_CLIP_SEC) return;
    const cue: Cue = {
      id: `cue-${this.nextId++}`,
      fixtureId,
      startSec,
      endSec,
      colorIndex: this.suggestedColorIndex,
      action,
    };
    this.pushHistory();
    this.cues = [...this.cues, cue];
    this.selectedFixtureId = fixtureId;
    this.selectedCueId = cue.id;
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  private pointerHover(event: PointerEvent): void {
    if (this.gesture !== null || this.timeline === null || event.shiftKey) {
      this.hideHover();
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      this.hideHover();
      return;
    }
    const clipElement = target.closest<HTMLElement>('.arrangement-clip');
    this.setHoveredCue(clipElement?.dataset.cueId ?? null);
    if (clipElement !== null || target.closest('.track-name') !== null) {
      this.hideHover();
      return;
    }
    const lane = target.closest<HTMLElement>('.fixture-lane');
    const fixtureId = lane?.parentElement?.dataset.fixtureId;
    const fixture = this.fixtures.find((item) => item.id === fixtureId);
    if (lane === null || fixture === undefined) {
      this.hideHover();
      return;
    }

    const startSec = this.snap(this.xToTime(event.clientX, lane));
    const length = Math.max(MIN_CLIP_SEC, Math.min(
      this.defaultLength(),
      this.timeline.durationSec - startSec,
    ));
    const action = this.defaultAction(fixture);
    const color = CUE_COLORS[this.suggestedColorIndex] ?? CUE_COLORS[0];

    let ghost = this.hoverGhost;
    if (ghost === null || !ghost.isConnected) {
      ghost = document.createElement('div');
      ghost.className = 'arrangement-ghost';
      this.hoverGhost = ghost;
    }
    if (ghost.parentElement !== lane) lane.appendChild(ghost);
    ghost.style.left = `${startSec * this.pixelsPerSecond}px`;
    ghost.style.width = `${Math.max(2, length * this.pixelsPerSecond)}px`;
    ghost.textContent = `${action} · ${color.name}`;
  }

  private hideHover(): void {
    this.hoverGhost?.remove();
    this.hoverGhost = null;
  }

  private renderRows(): void {
    const timeline = this.timeline;
    if (timeline === null) return;
    this.hoverGhost = null;
    const secondsWidth = timeline.durationSec * this.pixelsPerSecond;
    const beatWidth = timeline.bpm !== null && timeline.bpm > 0
      ? (60 / timeline.bpm) * this.pixelsPerSecond
      : null;
    const barWidth = beatWidth === null ? null : beatWidth * timeline.beatsPerBar;
    const gridMode = beatWidth === null
      ? 'none'
      : beatWidth / 4 >= 6
        ? 'sixteenths'
        : beatWidth >= 8
          ? 'beats'
          : barWidth !== null && barWidth >= 12 ? 'bars' : 'none';
    this.root.dataset.grid = gridMode;
    const rows = this.fixtures.map((fixture) => {
      const selected = fixture.id === this.selectedFixtureId;
      const hidden = this.hiddenFixtureIds.has(fixture.id);
      const clips = this.cues
        .filter((cue) => cue.fixtureId === fixture.id)
        .map((cue) => {
          const color = CUE_COLORS[cue.colorIndex % CUE_COLORS.length] ?? CUE_COLORS[0];
          const left = cue.startSec * this.pixelsPerSecond;
          const width = (cue.endSec - cue.startSec) * this.pixelsPerSecond;
          return `<div class="arrangement-clip" data-cue-id="${cue.id}" data-start-px="${left}" data-end-px="${left + width}" style="left:${left}px;width:${width}px" title="${cue.action} · ${color.name}">
            <span class="clip-resize start"></span><span class="clip-resize end"></span>
          </div>`;
        }).join('');
      const gridStyle = beatWidth === null
        ? ''
        : `--sixteenth-width:${beatWidth / 4}px;--beat-width:${beatWidth}px;--bar-width:${beatWidth * timeline.beatsPerBar}px;--grid-offset-x:${timeline.firstBeatSec * this.pixelsPerSecond}px;`;
      const loopMarkup = this.loopMarkup(timeline, secondsWidth);
      return `<div class="fixture-row${selected ? ' selected' : ''}${hidden ? ' hidden' : ''}" data-fixture-id="${fixture.id}">
        <button type="button" class="track-name" title="${fixture.profile.name}">
          <span class="track-indicator" style="--track-color:${this.trackColor(fixture)}"></span>
          <span class="track-copy"><b>${fixture.id}</b><small>${this.kindLabel(fixture.profile.kind)} · ${this.capabilitySummary(fixture)}</small></span>
          <span class="track-visibility" role="button" tabindex="0" aria-pressed="${hidden}" aria-label="${hidden ? 'Show' : 'Hide'} ${fixture.id} in the 3D scene" title="${hidden ? 'Show' : 'Hide'} in the scene">${hidden ? '◌' : '◉'}</span>
        </button>
        <div class="fixture-lane" style="width:${secondsWidth}px;${gridStyle}">
          ${loopMarkup}${clips}
        </div>
      </div>`;
    }).join('');
    this.root.innerHTML = `${rows}<span class="arrangement-playhead global" aria-hidden="true"></span>`;
    this.root.appendChild(this.overlay);
    this.playheadLine = this.root.querySelector<HTMLElement>('.arrangement-playhead.global');
    this.clipElements = [...this.root.querySelectorAll<HTMLElement>('.arrangement-clip')];
    this.trackWidth = this.root.querySelector<HTMLElement>('.track-name')?.offsetWidth ?? TRACK_LABEL_WIDTH;
    this.rowsHeight = this.root.offsetHeight;
    this.setSongTime(this.songTime);
    this.updateClipVisibility();
    this.drawClips();
  }

  private setHoveredCue(cueId: string | null): void {
    if (this.hoveredCueId === cueId) return;
    this.hoveredCueId = cueId;
    this.scheduleDraw();
  }

  private scheduleDraw(): void {
    if (this.overlayFrame !== 0) return;
    this.overlayFrame = requestAnimationFrame(() => {
      this.overlayFrame = 0;
      this.drawClips();
    });
  }

  /** Paint the visible clips for every track into one canvas overlay. */
  private drawClips(): void {
    const timeline = this.timeline;
    const canvas = this.overlay;
    if (timeline === null) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }
    const width = Math.max(1, this.scroller.clientWidth - this.trackWidth);
    const height = Math.max(1, this.rowsHeight || this.root.offsetHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const scrollLeft = this.scroller.scrollLeft;
    canvas.style.transform = `translate3d(${scrollLeft}px, 0, 0)`;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = this.overlayCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pps = this.pixelsPerSecond;
    const rowHeight = height / Math.max(1, this.fixtures.length);
    const byFixture = new Map<string, Cue[]>();
    for (const cue of this.cues) {
      const list = byFixture.get(cue.fixtureId);
      if (list === undefined) byFixture.set(cue.fixtureId, [cue]);
      else list.push(cue);
    }

    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';

    for (const [index, fixture] of this.fixtures.entries()) {
      const cues = byFixture.get(fixture.id);
      if (cues === undefined) continue;
      // Row content is dimmed via CSS, but clips live in this shared canvas.
      ctx.globalAlpha = this.hiddenFixtureIds.has(fixture.id) ? HIDDEN_ROW_OPACITY : 1;
      const y = index * rowHeight + 4;
      const h = Math.max(2, rowHeight - 8);
      for (const cue of cues) {
        const x = cue.startSec * pps - scrollLeft;
        const w = (cue.endSec - cue.startSec) * pps;
        if (x + w < 0 || x > width) continue;
        const color = CUE_COLORS[cue.colorIndex % CUE_COLORS.length] ?? CUE_COLORS[0];
        const selected = cue.id === this.selectedCueId;
        const hovered = cue.id === this.hoveredCueId;
        ctx.beginPath();
        ctx.roundRect(x, y, Math.max(2, w), h, 4);
        ctx.fillStyle = color.css;
        ctx.fill();
        if (hovered) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
          ctx.fill();
        }
        ctx.lineWidth = selected ? 1.5 : 1;
        ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255, 255, 255, 0.22)';
        ctx.stroke();
        if (w >= 54) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
          ctx.fillText(`${cue.action} · ${color.name}`, x + 6, y + h / 2, Math.max(1, w - 10));
        }
      }
    }
    ctx.globalAlpha = 1;

    const preview = this.preview;
    if (preview !== null) {
      const index = this.fixtures.findIndex((fixture) => fixture.id === preview.fixtureId);
      if (index >= 0) {
        const x = preview.startSec * pps - scrollLeft;
        const w = Math.max(2, (preview.endSec - preview.startSec) * pps);
        const y = index * rowHeight + 4;
        const h = Math.max(2, rowHeight - 8);
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 4);
        ctx.fillStyle = 'rgba(122, 209, 255, 0.18)';
        ctx.fill();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(122, 209, 255, 0.9)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  private scheduleClipVisibility(): void {
    if (this.visibilityFrame !== 0) return;
    this.visibilityFrame = requestAnimationFrame(() => {
      this.visibilityFrame = 0;
      this.updateClipVisibility();
    });
  }

  /**
   * Hundreds of clips are authored on the grid, but only ~one screen of song is
   * visible. Hiding the rest keeps Firefox from rasterising the whole lane
   * every time the timeline repaints.
   */
  private updateClipVisibility(): void {
    if (this.clipElements.length === 0) return;
    const scrollLeft = this.scroller.scrollLeft;
    const margin = this.scroller.clientWidth * 0.5;
    const from = scrollLeft - margin;
    const to = scrollLeft + this.scroller.clientWidth + margin;
    for (const element of this.clipElements) {
      const startPx = Number(element.dataset.startPx);
      const endPx = Number(element.dataset.endPx);
      const visible = endPx >= from && startPx <= to;
      const display = visible ? '' : 'none';
      if (element.style.display !== display) element.style.display = display;
    }
  }

  private loopMarkup(timeline: CueTimeline, width: number): string {
    const start = timeline.loopStartSec;
    const end = timeline.loopEndSec;
    if (start === undefined || end === undefined || end <= start) return '';
    const left = clamp(start * this.pixelsPerSecond, 0, width);
    const right = clamp(end * this.pixelsPerSecond, 0, width);
    const before = left > 0 ? `<span class="lane-outside" style="left:0;width:${left}px"></span>` : '';
    const after = right < width ? `<span class="lane-outside" style="left:${right}px;width:${width - right}px"></span>` : '';
    return `${before}${after}<span class="lane-loop" style="left:${left}px;width:${Math.max(0, right - left)}px"></span>`;
  }

  private notifyChange(): void {
    this.onChange(this.cues);
  }

  private snapshot(): CueSnapshot {
    return {
      cues: this.cues.map((cue) => ({ ...cue })),
      selectedCueId: this.selectedCueId,
    };
  }

  /** Record the current state as an undo step and drop any redo branch. */
  private pushHistory(): void {
    this.pushSnapshot(this.snapshot());
  }

  private pushSnapshot(snapshot: CueSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  private restore(snapshot: CueSnapshot): void {
    this.cues = snapshot.cues.map((cue) => ({ ...cue }));
    this.selectedCueId = snapshot.selectedCueId !== null
      && this.cues.some((cue) => cue.id === snapshot.selectedCueId)
      ? snapshot.selectedCueId
      : null;
    this.preview = null;
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  private notifySelection(): void {
    this.onSelection(this.selectedFixture, this.selectedCue);
  }

  private defaultLength(): number {
    const bpm = this.timeline?.bpm;
    return bpm !== null && bpm !== undefined && bpm > 0 ? (60 / bpm) * 2 : 2;
  }

  private defaultAction(fixture: FixturePlacement): CueAction {
    if (this.pendingAction !== null && this.actionsFor(fixture).includes(this.pendingAction)) {
      return this.pendingAction;
    }
    return fixture.profile.capabilities.panTilt ? 'sweep' : fixture.profile.capabilities.strobe ? 'strobe' : 'hold';
  }

  private snap(timeSec: number): number {
    const timeline = this.timeline;
    if (timeline === null || timeline.bpm === null || timeline.bpm <= 0) {
      return clamp(timeSec, 0, timeline?.durationSec ?? 0);
    }
    const divisionSec = 60 / timeline.bpm / 4;
    return clamp(
      timeline.firstBeatSec + Math.round((timeSec - timeline.firstBeatSec) / divisionSec) * divisionSec,
      0,
      timeline.durationSec,
    );
  }

  private xToTime(clientX: number, lane: HTMLElement): number {
    return (clientX - lane.getBoundingClientRect().left) / this.pixelsPerSecond;
  }

  private trackColor(fixture: FixturePlacement): string {
    if (fixture.profile.capabilities.panTilt) return '#41a8ff';
    if (fixture.profile.capabilities.strobe) return '#ff7e53';
    return '#56d3aa';
  }

  private kindLabel(kind: string): string {
    return kind.split('-').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
  }

  private capabilitySummary(fixture: FixturePlacement): string {
    const caps = fixture.profile.capabilities;
    return [
      caps.dimmer ? 'Dim' : null,
      caps.color ? 'Color' : null,
      caps.panTilt ? 'Pan/Tilt' : null,
      caps.strobe ? 'Strobe' : null,
    ].filter((value) => value !== null).join(' · ');
  }
}

/**
 * Converts one arrangement cue into the evaluator's clip form. Pure so the
 * stage and headless tests share exactly the same interpretation of a cue.
 */
export function cueToClip(fixture: FixturePlacement | undefined, cue: Cue): Clip {
  const caps = fixture?.profile.capabilities;
  const color = CUE_COLORS[cue.colorIndex % CUE_COLORS.length] ?? CUE_COLORS[0];
  const attrs: Clip['attributes'] = {
    dimmer: cue.action === 'fade'
      ? [{ at: 0, value: 0 }, { at: 1, value: 0.9 }]
      : cue.action === 'pulse'
        ? [
            { at: 0, value: 0.9 },
            { at: 0.12, value: 0.08 },
            { at: 0.24, value: 0.9 },
            { at: 0.36, value: 0.08 },
            { at: 0.48, value: 0.9 },
            { at: 0.6, value: 0.08 },
            { at: 0.72, value: 0.9 },
            { at: 0.84, value: 0.08 },
            { at: 1, value: 0.9 },
          ]
        : [{ at: 0, value: 0.9 }],
  };

  if (caps?.color) {
    attrs.red = [{ at: 0, value: color.rgb[0] }];
    attrs.green = [{ at: 0, value: color.rgb[1] }];
    attrs.blue = [{ at: 0, value: color.rgb[2] }];
  }
  if (cue.action === 'sweep' && caps?.panTilt) {
    attrs.pan = [{ at: 0, value: 0.15 }, { at: 0.5, value: 0.85 }, { at: 1, value: 0.15 }];
    attrs.tilt = [{ at: 0, value: 0.42 }, { at: 0.5, value: 0.66 }, { at: 1, value: 0.42 }];
  }
  if (cue.action === 'strobe' && caps?.strobe) attrs.strobe = [{ at: 0, value: 0.78 }];

  return {
    id: cue.id,
    startSec: cue.startSec,
    endSec: cue.endSec,
    fadeInSec: cue.fadeInSec ?? (cue.action === 'fade' ? 0 : 0.04),
    fadeOutSec: 0.08,
    easing: cue.action === 'sweep' ? 'sine' : cue.action === 'pulse' ? 'step' : 'linear',
    attributes: attrs,
  };
}

export function createRuler(
  canvas: HTMLCanvasElement,
  timeline: CueTimeline,
  width: number,
  pixelsPerSecond = PIXELS_PER_SECOND,
): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(28 * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = '28px';
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas unavailable');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#111720';
  ctx.fillRect(0, 0, width, 28);
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  const beatSec = timeline.bpm !== null && timeline.bpm > 0 ? 60 / timeline.bpm : null;
  if (beatSec === null) {
    ctx.fillStyle = '#7a8399';
    ctx.fillText('Beat grid not set — load audio or set BPM', 8, 14);
    return;
  }

  const beatsPerBar = Math.max(1, timeline.beatsPerBar);
  const barSec = beatSec * beatsPerBar;
  const beatPx = beatSec * pixelsPerSecond;
  const barPx = barSec * pixelsPerSecond;
  const firstBeat = timeline.firstBeatSec;

  const loopStart = timeline.loopStartSec;
  const loopEnd = timeline.loopEndSec;
  if (loopStart !== undefined && loopEnd !== undefined && loopEnd > loopStart) {
    const loopX0 = Math.max(0, loopStart * pixelsPerSecond);
    const loopX1 = Math.min(width, loopEnd * pixelsPerSecond);
    ctx.fillStyle = 'rgba(122, 209, 255, 0.07)';
    ctx.fillRect(loopX0, 0, Math.max(0, loopX1 - loopX0), 28);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, loopX0, 28);
    ctx.fillRect(loopX1, 0, Math.max(0, width - loopX1), 28);
    ctx.fillStyle = 'rgba(122, 209, 255, 0.6)';
    ctx.fillRect(Math.round(loopX0), 0, 1, 28);
    ctx.fillRect(Math.round(loopX1) - 1, 0, 1, 28);
    // Grab handles for dragging the loop in/out points.
    ctx.fillStyle = 'rgba(122, 209, 255, 0.95)';
    for (const x of [loopX0, loopX1]) {
      if (x < 0 || x > width) continue;
      ctx.beginPath();
      ctx.moveTo(x - 5, 0);
      ctx.lineTo(x + 5, 0);
      ctx.lineTo(x, 7);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Sub-beat ticks only make sense once a beat is wide enough to read.
  if (beatPx >= 18) {
    const sixteenthPx = beatPx / 4;
    if (sixteenthPx >= 6) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      for (let i = 0; i * beatSec / 4 + firstBeat <= timeline.durationSec; i += 1) {
        const x = (firstBeat + (i * beatSec) / 4) * pixelsPerSecond;
        if (x < 0 || x > width) continue;
        if (i % 4 === 0) continue;
        ctx.fillRect(Math.round(x), 22, 1, 6);
      }
    }
  }

  if (beatPx >= 5) {
    const lastBeat = Math.ceil((timeline.durationSec - firstBeat) / beatSec);
    for (let index = 0; index <= lastBeat; index += 1) {
      const x = (firstBeat + index * beatSec) * pixelsPerSecond;
      if (x < 0 || x > width) continue;
      if (index % beatsPerBar === 0) continue;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.fillRect(Math.round(x), 20, 1, 8);
    }
  }

  // Label every Nth bar so numbers never collide, and add a bar tick at each.
  const labelEvery = Math.max(1, Math.ceil(58 / Math.max(1, barPx)));
  const lastBar = Math.ceil((timeline.durationSec - firstBeat) / barSec);
  for (let bar = 0; bar <= lastBar; bar += 1) {
    const x = (firstBeat + bar * barSec) * pixelsPerSecond;
    if (x < -2 || x > width + 2) continue;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(Math.round(x), 14, 1, 14);
    if (bar % labelEvery !== 0) continue;
    const label = String(bar + 1);
    if (x + 4 + ctx.measureText(label).width > width) continue;
    ctx.fillStyle = '#aeb8ca';
    ctx.fillText(label, x + 4, 8);
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Structural comparison used to decide whether a drag produced an undo step. */
function sameCues(a: readonly Cue[], b: readonly Cue[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.id !== right.id
      || left.fixtureId !== right.fixtureId
      || left.startSec !== right.startSec
      || left.endSec !== right.endSec
      || left.colorIndex !== right.colorIndex
      || left.action !== right.action
      || left.fadeInSec !== right.fadeInSec) return false;
  }
  return true;
}
