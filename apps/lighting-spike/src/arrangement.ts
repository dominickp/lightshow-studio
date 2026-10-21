import type { Clip, FixturePlacement, Keyframe, LedLookState, LedSurface } from '@dmxsim/show-model';
import { actionsFor } from './arrangement/capabilities';
import {
  canMoveCueToLane,
  canPasteOn,
  clipboardAnchor,
  copySelection,
  laneOrder,
  pastePlacements as resolvePastePlacements,
} from './arrangement/clipboard';
import { CUE_COLORS, resolveCueColor } from './arrangement/colors';
import { EDGE_GRAB_PX, MIN_CLIP_SEC } from './arrangement/constants';
import { CueHistory } from './arrangement/history';
import {
  buildRowsMarkup,
  capabilitySummary,
  gridModeFor,
  kindLabel,
} from './arrangement/markup';
import { paintClipOverlay } from './arrangement/paint';
import { defaultClipLength, snapDelta as snapDeltaToGrid, snapTime } from './arrangement/time';
import type {
  ClipClipboardItem,
  Cue,
  CueAction,
  CueColorOverride,
  CueSnapshot,
  CueTimeline,
  TimelineMode,
} from './arrangement/types';
import { isSurfaceCue } from './arrangement/types';
import { defaultLedLook } from '@dmxsim/show-model';
import { lookDefinition } from './led/look-definitions';
import { clamp } from './lib/math';

export { CUE_COLORS } from './arrangement/colors';
export type {
  Cue,
  CueAction,
  CueColorOverride,
  CueTimeline,
  TimelineMode,
} from './arrangement/types';

export const PIXELS_PER_SECOND = 48;
export const MIN_PIXELS_PER_SECOND = 0.25;
export const MAX_PIXELS_PER_SECOND = 480;
export const TRACK_LABEL_WIDTH = 176;

/** Short `m:ss` label for the paste-at-pointer menu. */
const formatClockLabel = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${Math.floor(safe % 60).toString().padStart(2, '0')}`;
};

type Gesture =
  | { type: 'create'; fixtureId: string; startSec: number; currentSec: number }
  | { type: 'move'; cueId: string; startSec: number; initialStartSec: number; durationSec: number }
  | {
      type: 'move-many';
      anchorSec: number;
      /** Lane the grabbed cue started on; cross-track drags shift relative to it. */
      anchorLaneId: string;
      items: { cueId: string; startSec: number; durationSec: number; fixtureId: string }[];
    }
  | { type: 'resize'; cueId: string; edge: 'start' | 'end' }
  /** Rubber-band selection. Coordinates are client-space so scrolling during
   * the drag does not shift the rectangle. */
  | { type: 'marquee'; startX: number; startY: number; base: ReadonlySet<string> };

export class Arrangement {
  private timeline: CueTimeline | null = null;
  private cues: Cue[] = [];
  private fixtures: FixturePlacement[];
  /** Walls that own a lane in this arrangement. */
  private surfaces: LedSurface[];
  /** Lane id of the selected fixture or surface. */
  private selectedFixtureId: string | null = null;
  /**
   * Fixture whose settings are open in the side panel. The row highlight and
   * the 3D selection marker follow this, not plain selection, so both turn on
   * and off with the panel.
   */
  private activeFixtureId: string | null = null;
  /** Every selected cue. Most of the time this holds zero or one id; select
   * mode allows many so copy/paste and delete can act on a batch. */
  private readonly selectedCueIds = new Set<string>();
  private mode: TimelineMode = 'drop';
  private clipboard: ClipClipboardItem[] = [];
  private marquee: HTMLElement | null = null;
  private contextMenu: HTMLElement | null = null;
  /** Dashed paste preview while the context menu is open. */
  private pastePreview: { anchorSec: number; targetFixtureId: string | null } | null = null;
  /** Last time and track under the pointer, used by paste-at-pointer and the
   * select-mode hover marker. */
  private pointerTimeSec: number | null = null;
  private pointerFixtureId: string | null = null;
  private readonly hiddenFixtureIds = new Set<string>();
  private gesture: Gesture | null = null;
  private gestureSnapshot: CueSnapshot | null = null;
  private readonly history = new CueHistory();
  private nextId = 1;
  private songTime = 0;
  private pixelsPerSecond = PIXELS_PER_SECOND;
  private pendingAction: CueAction | null = null;
  private pendingColorIndex: number | null = null;
  private pendingColorOverride: CueColorOverride | null = null;
  /** Look used for the next surface clip when one is pending. */
  private pendingLook: LedLookState | null = null;
  /** One undo boundary for a continuous look-slider gesture. */
  private lookEditSnapshot: CueSnapshot | null = null;
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
  private subtitleResolver: ((fixture: FixturePlacement) => string) | null = null;
  /** When set, only tracks whose fixture profile has this `kind` are drawn. */
  private kindFilter: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly scroller: HTMLElement,
    fixtures: FixturePlacement[],
    private readonly onChange: (cues: readonly Cue[]) => void,
    private readonly onSelection: (
      fixture: FixturePlacement | null,
      cues: readonly Cue[],
      surface: LedSurface | null,
    ) => void,
    private readonly onVisibilityChange?: (fixtureId: string, hidden: boolean) => void,
    /**
     * Fired when a track's name is clicked (after selection has been applied).
     * The shell uses it to toggle the fixture side panel without the
     * arrangement needing to know whether that panel is open.
     */
    private readonly onTrackName?: (fixture: FixturePlacement | null, surface: LedSurface | null) => void,
    surfaces: readonly LedSurface[] = [],
  ) {
    this.fixtures = fixtures;
    this.surfaces = [...surfaces];
    this.root.dataset.mode = this.mode;
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
      this.hideContextMenu();
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
      if (this.pointerTimeSec !== null || this.pointerFixtureId !== null) {
        this.pointerTimeSec = null;
        this.pointerFixtureId = null;
        this.scheduleDraw();
      }
    });
    this.root.addEventListener('contextmenu', (event) => this.openContextMenu(event));
    document.addEventListener('pointerdown', (event) => {
      if (this.contextMenu === null) return;
      if (event.target instanceof Node && this.contextMenu.contains(event.target)) return;
      this.hideContextMenu();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hideContextMenu();
    });
  }

  get selectedFixture(): FixturePlacement | null {
    return this.fixtures.find((fixture) => fixture.id === this.selectedFixtureId) ?? null;
  }

  /**
   * Mark which fixture is open in the side panel. Passing `null` (or closing
   * the panel) clears the row highlight; selection for editing is unaffected.
   */
  setActiveFixture(fixtureId: string | null): void {
    if (this.activeFixtureId === fixtureId) return;
    this.activeFixtureId = fixtureId;
    this.renderRows();
  }

  /**
   * Replace the rig (add/remove/reorder). Cues for fixtures that still exist
   * are kept verbatim; cues for removed fixtures are dropped, matching the
   * project schema's rule against dangling `fixtureId` references.
   */
  setFixtures(fixtures: FixturePlacement[]): void {
    this.fixtures = fixtures;
    const ids = new Set(fixtures.map((fixture) => fixture.id));

    const keptCues = this.cues.filter((cue) => ids.has(cue.fixtureId));
    if (keptCues.length !== this.cues.length) {
      this.cues = keptCues;
      this.notifyChange();
    }

    if (this.selectedFixtureId !== null && !ids.has(this.selectedFixtureId)) {
      this.selectedFixtureId = fixtures[0]?.id ?? null;
      this.selectedCueIds.clear();
    }
    if (this.activeFixtureId !== null && !ids.has(this.activeFixtureId)) {
      this.activeFixtureId = null;
    }
    for (const fixtureId of [...this.hiddenFixtureIds]) {
      if (!ids.has(fixtureId)) this.hiddenFixtureIds.delete(fixtureId);
    }

    this.renderRows();
    this.notifySelection();
  }

  /**
   * Optional second line under a track name, e.g. the mount anchor. The shell
   * supplies it because the arrangement does not know about venues.
   */
  setSubtitleResolver(resolver: ((fixture: FixturePlacement) => string) | null): void {
    this.subtitleResolver = resolver;
    this.renderRows();
  }

  /**
   * Show only tracks of one fixture kind (`laser`, `wash`, …), or all tracks
   * with `null`. Clips and the playhead are unaffected; only rows are hidden.
   */
  setKindFilter(kind: string | null): void {
    if (this.kindFilter === kind) return;
    this.kindFilter = kind;
    this.renderRows();
  }

  /**
   * Fixtures currently drawn as lanes. The DOM rows and the shared clip canvas
   * must both use this list so clip positions line up with their lanes.
   */
  private visibleFixtures(): FixturePlacement[] {
    return this.kindFilter === null
      ? this.fixtures
      : this.fixtures.filter((fixture) => fixture.profile.kind === this.kindFilter);
  }

  /** `led-wall` is a filter value surfaces answer to; every other filter hides
   * them, so isolating a fixture type really isolates it. */
  private visibleSurfaces(): LedSurface[] {
    return this.kindFilter === null || this.kindFilter === 'led-wall' ? this.surfaces : [];
  }

  private surfaceById(id: string | null): LedSurface | null {
    if (id === null) return null;
    return this.surfaces.find((surface) => surface.id === id) ?? null;
  }

  get selectedSurface(): LedSurface | null {
    return this.surfaceById(this.selectedFixtureId);
  }

  private laneExists(id: string): boolean {
    return this.fixtures.some((fixture) => fixture.id === id)
      || this.surfaces.some((surface) => surface.id === id);
  }

  /** Replace the wall list, e.g. after opening a project or editing the wall. */
  setSurfaces(surfaces: readonly LedSurface[]): void {
    this.surfaces = [...surfaces];
    this.renderRows();
  }

  /** Look of the selected surface clip, or the pending look when none is. */
  get selectedLook(): LedLookState | null {
    return this.selectedCue?.look ?? null;
  }

  get suggestedLook(): LedLookState {
    return this.pendingLook ?? this.selectedCue?.look ?? defaultLedLook('gradient');
  }

  /** Apply a look to every selected surface clip (or set it as the default). */
  setSelectedLook(look: LedLookState): void {
    this.applyLookToSelection(look, true);
  }

  /** Start a live-edited look gesture with a single undo snapshot. */
  beginLookEdit(): void {
    if (this.lookEditSnapshot === null) this.lookEditSnapshot = this.snapshot();
  }

  /** Preview a slider value without creating one history entry per input event. */
  previewSelectedLook(look: LedLookState): void {
    this.applyLookToSelection(look, false);
  }

  /** Commit the live preview as one undoable look edit. */
  commitLookEdit(): void {
    const snapshot = this.lookEditSnapshot;
    this.lookEditSnapshot = null;
    if (snapshot !== null && !sameCues(snapshot.cues, this.cues)) this.pushSnapshot(snapshot);
  }

  private applyLookToSelection(look: LedLookState, record: boolean): void {
    const targets = new Set(
      this.selectedCues.filter((cue) => isSurfaceCue(cue)).map((cue) => cue.id),
    );
    const copy = { ...look, colors: [...look.colors] };
    if (targets.size === 0) {
      this.pendingLook = copy;
      this.notifySelection();
      return;
    }
    if (record) this.pushHistory();
    this.cues = this.cues.map((cue) => (targets.has(cue.id) ? { ...cue, look: copy } : cue));
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** Choose the generator used for the next surface clip. */
  setPendingLookKind(kind: LedLookState['kind']): void {
    this.pendingLook = { ...defaultLedLook(kind) };
    this.notifySelection();
  }

  /** Friendly label for a fixture: its name when set, otherwise its id. */
  labelFor(fixture: FixturePlacement): string {
    return fixture.name ?? fixture.id;
  }

  get selectedCue(): Cue | null {
    return this.selectedCues[0] ?? null;
  }

  get selectedCues(): Cue[] {
    return this.cues.filter((cue) => this.selectedCueIds.has(cue.id));
  }

  get selectionCount(): number {
    return this.selectedCueIds.size;
  }

  get hasSelection(): boolean {
    return this.selectedCueIds.size > 0;
  }

  get canPaste(): boolean {
    return this.clipboard.length > 0;
  }

  /** Time under the pointer, or `null` when it is not over a lane. */
  get pointerTime(): number | null {
    return this.pointerTimeSec;
  }

  get timelineMode(): TimelineMode {
    return this.mode;
  }

  /**
   * Switch between drawing clips and selecting them. The authored clips and
   * the current selection are kept; only the pointer behaviour changes.
   */
  setMode(mode: TimelineMode): void {
    if (this.mode === mode) return;
    this.cancelGesture();
    this.hideHover();
    this.setHoveredCue(null);
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.pointerTimeSec = null;
    this.pointerFixtureId = null;
    this.renderRows();
  }

  /** Select every cue on the currently visible tracks. */
  selectAll(): void {
    const fixtures = new Set([
      ...this.visibleSurfaces().map((surface) => surface.id),
      ...this.visibleFixtures().map((fixture) => fixture.id),
    ]);
    this.selectedCueIds.clear();
    for (const cue of this.cues) {
      if (fixtures.has(cue.fixtureId)) this.selectedCueIds.add(cue.id);
    }
    this.renderRows();
    this.notifySelection();
  }

  clearSelection(): void {
    if (this.selectedCueIds.size === 0) return;
    this.selectedCueIds.clear();
    this.renderRows();
    this.notifySelection();
  }

  /**
   * Add one cue to the selection. `toggle` (Ctrl/Cmd) removes an already
   * selected cue; plain Shift only adds, matching most editors.
   */
  private selectCue(cueId: string, additive: boolean, toggle: boolean): void {
    if (!additive) this.selectedCueIds.clear();
    if (additive && toggle && this.selectedCueIds.has(cueId)) this.selectedCueIds.delete(cueId);
    else this.selectedCueIds.add(cueId);
  }

  get selectedActions(): CueAction[] {
    const fixture = this.selectedFixture;
    return fixture === null ? [] : actionsFor(fixture);
  }

  get suggestedAction(): CueAction {
    const fixture = this.selectedFixture;
    if (fixture === null) return this.pendingAction ?? 'hold';
    if (this.pendingAction !== null && actionsFor(fixture).includes(this.pendingAction)) {
      return this.pendingAction;
    }
    return this.defaultAction(fixture);
  }

  get suggestedColorIndex(): number {
    return this.pendingColorIndex ?? (this.cues.length % CUE_COLORS.length);
  }

  /** Custom color that applies to the next clip, when one is pending. */
  get suggestedColorOverride(): CueColorOverride | null {
    return this.pendingColorOverride;
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
    this.selectedCueIds.clear();
    this.preview = null;
    this.clearHistory();
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** Replace the authored clips, e.g. with a seeded demo arrangement. */
  setCues(cues: readonly Cue[]): void {
    // Cue ids are the identity used by selection, gestures and delete, so two
    // cues sharing one must be repaired on load. See `reserveCueIds`.
    const reserved = reserveCueIds(
      cues.filter((cue) => this.laneExists(cue.fixtureId)),
    );
    this.cues = reserved.cues;
    // Never move the counter backwards: a later save can then not reissue an
    // id that this session already handed out.
    this.nextId = Math.max(this.nextId, reserved.nextId);
    this.selectedCueIds.clear();
    this.preview = null;
    this.clearHistory();
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** Revert the last clip edit (add, delete, move, resize, action or color). */
  undo(): void {
    const previous = this.history.undo(this.snapshot());
    if (previous !== null) this.restore(previous);
  }

  /** Re-apply the most recently undone clip edit. */
  redo(): void {
    const next = this.history.redo(this.snapshot());
    if (next !== null) this.restore(next);
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
    if (!this.laneExists(fixtureId)) return;
    this.selectedFixtureId = fixtureId;
    this.selectedCueIds.clear();
    this.renderRows();
    this.notifySelection();
  }

  /** Apply an action to every selected clip whose fixture supports it. */
  setSelectedAction(action: CueAction): void {
    const targets = new Set(
      this.selectedCues
        .filter((cue) => {
          const fixture = this.fixtures.find((item) => item.id === cue.fixtureId);
          return fixture !== undefined && actionsFor(fixture).includes(action);
        })
        .map((cue) => cue.id),
    );
    if (targets.size === 0) return;
    this.pushHistory();
    this.cues = this.cues.map((item) => targets.has(item.id)
      ? {
          ...item,
          action,
          // Pin the movement speed when a clip becomes a sweep, so resizing
          // the clip later does not slow it down.
          ...(action === 'sweep' && item.sweep === undefined
            ? { sweep: { hz: sweepRateForLength(item.endSec - item.startSec) } }
            : {}),
        }
      : item);
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** Apply a color to every selected clip whose fixture supports color. */
  setSelectedColor(colorIndex: number, colorOverride?: CueColorOverride): void {
    const targets = new Set(
      this.selectedCues
        .filter((cue) => this.fixtures.find((item) => item.id === cue.fixtureId)?.profile.capabilities.color)
        .map((cue) => cue.id),
    );
    if (targets.size === 0) return;
    this.pushHistory();
    this.cues = this.cues.map((item) => targets.has(item.id)
      ? { ...item, colorIndex, ...(colorOverride === undefined ? {} : { colorOverride }) }
      : item);
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /**
   * Apply per-clip timing and pulse settings to the selection.
   *
   * A shallow merge is enough here: the inspector always sends the full
   * `strobe` object it wants, so stale attack/release values cannot survive.
   * Slider drags pass `history: false` after a single `beginClipEdit`, so one
   * gesture is one undo step instead of one per pointer move.
   */
  setSelectedClipSettings(
    patch: Partial<Pick<Cue, 'fadeInSec' | 'fadeOutSec' | 'pulseHz' | 'strobe' | 'sweep'>>,
    options: { history?: boolean } = {},
  ): void {
    if (this.selectedCueIds.size === 0) return;
    if (options.history !== false) this.pushHistory();
    this.cues = this.cues.map((item) => this.selectedCueIds.has(item.id)
      ? { ...item, ...patch }
      : item);
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** Open an undo step before a slider drag that will use `history: false`. */
  beginClipEdit(): void {
    if (this.selectedCueIds.size === 0) return;
    this.pushHistory();
  }

  /**
   * Evenly offset the selected sweep clips around the movement cycle.
   *
   * Heads are ordered by lane so the spread reads left to right across the
   * rig. The anchor clip's rate is written to every clip as an explicit Hz;
   * without that, clips of different lengths would move at different speeds
   * and the phase offset would not hold.
   */
  spreadSelectedSweepPhase(): void {
    const targets = this.selectedCues.filter((cue) => cue.action === 'sweep');
    if (targets.length < 2) return;
    this.pushHistory();
    const laneIndex = new Map(laneOrder(this.fixtures, this.surfaces).map((id, index) => [id, index]));
    const sorted = [...targets].sort((a, b) =>
      (laneIndex.get(a.fixtureId) ?? 0) - (laneIndex.get(b.fixtureId) ?? 0)
      || a.startSec - b.startSec);
    const anchor = sorted[0]!;
    const hz = anchor.sweep?.hz ?? 1 / Math.max(0.001, anchor.endSec - anchor.startSec);
    const phases = new Map(sorted.map((cue, index) => [cue.id, index / sorted.length]));
    this.cues = this.cues.map((cue) => {
      const phase = phases.get(cue.id);
      return phase === undefined ? cue : { ...cue, sweep: { ...cue.sweep, hz, phase } };
    });
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** The action used for the next clip when nothing is selected. */
  setPendingAction(action: CueAction): void {
    const fixture = this.selectedFixture;
    if (fixture === null || !actionsFor(fixture).includes(action)) return;
    this.pendingAction = action;
    this.notifySelection();
  }

  /** The color used for the next clip when nothing is selected. */
  setPendingColor(colorIndex: number, colorOverride?: CueColorOverride): void {
    if (!this.selectedFixture?.profile.capabilities.color) return;
    const count = CUE_COLORS.length;
    this.pendingColorIndex = ((colorIndex % count) + count) % count;
    this.pendingColorOverride = colorOverride ?? null;
    this.notifySelection();
  }

  deleteSelected(): void {
    if (this.selectedCueIds.size === 0) return;
    this.pushHistory();
    this.cues = this.cues.filter((cue) => !this.selectedCueIds.has(cue.id));
    this.selectedCueIds.clear();
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /**
   * Copy the selection, normalised so the earliest clip starts at 0. Pasting
   * keeps each clip on its own track and their relative timing.
   */
  copySelected(): number {
    const copied = copySelection(this.selectedCues);
    // Copying nothing leaves the existing clipboard intact.
    if (copied.length === 0) return 0;
    this.clipboard = copied;
    // The new clipboard enables the select-mode paste hover marker.
    this.scheduleDraw();
    return this.clipboard.length;
  }

  /**
   * The topmost, earliest copied clip: it anchors the block when pasting onto
   * another track, so the clicked row becomes this clip's new row and the rest
   * keep their relative track offsets.
   */
  private clipboardAnchor(): { item: ClipClipboardItem; fixtureIndex: number } | null {
    return clipboardAnchor(this.clipboard, this.fixtures, this.surfaces);
  }

  /**
   * Resolve where the clipboard lands. With no target, clips keep their
   * original tracks. With a target fixture, the animated anchor clip moves to
   * that row and every other clip keeps its relative track offset; targets
   * that cannot perform a clip's controls are skipped.
   */
  private pastePlacements(
    atSec: number,
    targetFixtureId: string | null,
  ): { item: ClipClipboardItem; fixtureId: string; startSec: number; endSec: number }[] {
    const timeline = this.timeline;
    if (timeline === null) return [];
    return resolvePastePlacements({
      clipboard: this.clipboard,
      fixtures: this.fixtures,
      surfaces: this.surfaces,
      durationSec: timeline.durationSec,
      atSec,
      targetFixtureId,
      snap: (timeSec) => this.snap(timeSec),
    });
  }

  /** Whether "Paste here" is valid on a track: the anchor clip must fit it. */
  private canPasteOn(fixtureId: string): boolean {
    return canPasteOn(fixtureId, this.clipboard, this.fixtures, this.surfaces);
  }

  /**
   * Where a plain paste starts: immediately after the current selection, so
   * pasted clips follow what is selected instead of jumping to the playhead.
   * With nothing selected it falls back to the playhead. Repeated pastes chain
   * because the paste itself becomes the new selection.
   */
  private pasteStartSec(): number {
    const selected = this.selectedCues;
    if (selected.length === 0) return this.songTime;
    return Math.max(...selected.map((cue) => cue.endSec));
  }

  /**
   * Paste the copied clips so the block starts at `atSec` (just after the
   * current selection by default). Pass `targetFixtureId` to land the block on
   * another row; clips whose action/color the mapped track cannot perform are
   * skipped.
   */
  paste(atSec: number = this.pasteStartSec(), targetFixtureId: string | null = null): number {
    if (this.clipboard.length === 0 || this.timeline === null) return 0;
    const placements = this.pastePlacements(atSec, targetFixtureId);
    const pasted: Cue[] = placements.map((placement) => ({
      ...placement.item,
      fixtureId: placement.fixtureId,
      ...(placement.item.surfaceId === undefined ? {} : { surfaceId: placement.fixtureId }),
      id: this.nextCueId(),
      startSec: placement.startSec,
      endSec: placement.endSec,
    }));
    if (pasted.length === 0) return 0;
    this.pushHistory();
    this.cues = [...this.cues, ...pasted];
    this.selectedFixtureId = pasted[0]!.fixtureId;
    this.selectedCueIds.clear();
    for (const cue of pasted) this.selectedCueIds.add(cue.id);
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
    return pasted.length;
  }

  /** Paste at the hovered time on the hovered track, falling back to the
   * playhead on the original tracks when the pointer is outside the lanes. */
  pasteAtPointer(): number {
    const atSec = this.pointerTimeSec ?? this.songTime;
    return this.paste(atSec, this.pointerFixtureId);
  }

  private toggleFixtureVisibility(fixtureId: string): void {
    if (!this.laneExists(fixtureId)) return;
    const hidden = !this.hiddenFixtureIds.has(fixtureId);
    if (hidden) this.hiddenFixtureIds.add(fixtureId);
    else this.hiddenFixtureIds.delete(fixtureId);
    this.renderRows();
    this.onVisibilityChange?.(fixtureId, hidden);
  }

  toClip(cue: Cue): Clip {
    // Surface clips are media, not fixture envelopes; keep them out of the
    // fixture evaluator so a wall cue can never produce a bogus fixture clip.
    return cueToClip(
      cue.surfaceId === undefined ? this.fixtures.find((item) => item.id === cue.fixtureId) : undefined,
      cue,
    );
  }

  private pointerDown(event: PointerEvent): void {
    // Right-click opens the paste menu; it must not start a create/marquee
    // gesture or clear the current selection along the way.
    if (event.button !== 0) return;
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
      this.selectedCueIds.clear();
      this.renderRows();
      // Announce the name click before the selection sync: the shell uses this
      // to decide whether to open, switch or close the fixture panel, and the
      // sync would otherwise overwrite the panel's previous fixture.
      this.onTrackName?.(this.selectedFixture, this.selectedSurface);
      this.notifySelection();
      return;
    }
    const lane = target.closest<HTMLElement>('.fixture-lane');
    if (lane === null || this.timeline === null) return;

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const toggle = event.ctrlKey || event.metaKey;
    const clipElement = target.closest<HTMLElement>('.arrangement-clip');
    if (clipElement !== null) {
      const cueId = clipElement.dataset.cueId;
      const cue = this.cues.find((item) => item.id === cueId);
      if (cue === undefined) return;
      if (this.mode === 'select') {
        if (additive) {
          this.selectCue(cue.id, true, toggle);
          this.renderRows();
          this.notifySelection();
          event.preventDefault();
          return;
        }
        // Grabbing a clip edge resizes it; the rest of the card moves the
        // selection. Edge proximity matches drop mode's grab zone.
        const x = event.clientX - lane.getBoundingClientRect().left;
        const startHandle = target.closest('.clip-resize.start') !== null;
        const endHandle = target.closest('.clip-resize.end') !== null;
        const nearStart = Math.abs(x - cue.startSec * this.pixelsPerSecond) <= EDGE_GRAB_PX;
        const nearEnd = Math.abs(x - cue.endSec * this.pixelsPerSecond) <= EDGE_GRAB_PX;
        let edge: 'start' | 'end' | null = null;
        if (startHandle || (!endHandle && nearStart)) edge = 'start';
        else if (endHandle || nearEnd) edge = 'end';
        if (edge !== null) {
          this.selectedCueIds.clear();
          this.selectedCueIds.add(cue.id);
          this.gesture = { type: 'resize', cueId: cue.id, edge };
          this.gestureSnapshot = this.snapshot();
          this.renderRows();
          this.notifySelection();
          event.preventDefault();
          return;
        }
        // Clicking an unselected card selects it alone; clicking one that is
        // already part of the selection keeps the batch so it can be dragged.
        if (!this.selectedCueIds.has(cue.id)) {
          this.selectedCueIds.clear();
          this.selectedCueIds.add(cue.id);
        }
        this.gesture = {
          type: 'move-many',
          anchorSec: this.xToTime(event.clientX, lane),
          anchorLaneId: cue.fixtureId,
          items: this.selectedCues.map((selected) => ({
            cueId: selected.id,
            startSec: selected.startSec,
            durationSec: selected.endSec - selected.startSec,
            fixtureId: selected.fixtureId,
          })),
        };
        this.gestureSnapshot = this.snapshot();
        this.renderRows();
        this.notifySelection();
        event.preventDefault();
        return;
      }
      this.selectedCueIds.clear();
      this.selectedCueIds.add(cue.id);
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
    } else if (this.mode === 'select') {
      // Empty lane: start a rubber-band selection. Non-additive drags replace
      // the current selection; Shift/Ctrl adds to it.
      const base = additive ? new Set(this.selectedCueIds) : new Set<string>();
      if (!additive) this.selectedCueIds.clear();
      this.gesture = {
        type: 'marquee',
        startX: event.clientX,
        startY: event.clientY,
        base,
      };
      this.gestureSnapshot = null;
      // renderRows rebuilds the root's children, so the marquee is attached
      // afterwards to survive the DOM refresh.
      this.renderRows();
      this.showMarquee(event.clientX, event.clientY);
      this.notifySelection();
      event.preventDefault();
      return;
    } else {
      const time = this.snap(this.xToTime(event.clientX, lane));
      this.selectedCueIds.clear();
      this.gesture = { type: 'create', fixtureId, startSec: time, currentSec: time };
      this.gestureSnapshot = null;
      this.preview = { fixtureId, startSec: time, endSec: time + this.defaultLength() };
    }

    this.renderRows();
    this.notifySelection();
    event.preventDefault();
  }

  /** Draw (or move) the rubber-band rectangle in content coordinates. */
  private showMarquee(clientX: number, clientY: number): void {
    const gesture = this.gesture;
    if (gesture?.type !== 'marquee') return;
    const rootRect = this.root.getBoundingClientRect();
    const left = Math.min(gesture.startX, clientX) - rootRect.left;
    const top = Math.min(gesture.startY, clientY) - rootRect.top;
    const width = Math.abs(clientX - gesture.startX);
    const height = Math.abs(clientY - gesture.startY);
    let marquee = this.marquee;
    if (marquee === null || !marquee.isConnected) {
      marquee = document.createElement('div');
      marquee.className = 'arrangement-marquee';
      marquee.setAttribute('aria-hidden', 'true');
      this.marquee = marquee;
    }
    if (marquee.parentElement !== this.root) this.root.appendChild(marquee);
    Object.assign(marquee.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  private hideMarquee(): void {
    this.marquee?.remove();
    this.marquee = null;
  }

  /**
   * Right-click a lane to choose where pasted clips land: at the pointer or
   * at the playhead. Only offered when something has been copied.
   */
  private openContextMenu(event: MouseEvent): void {
    if (this.timeline === null) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const lane = target.closest<HTMLElement>('.fixture-lane');
    if (lane === null) return;
    const clipElement = target.closest<HTMLElement>('.arrangement-clip');
    const clipId = clipElement?.dataset.cueId;
    const cue = clipId === undefined ? undefined : this.cues.find((item) => item.id === clipId);
    // Empty lane with nothing copied: leave the browser's native menu alone.
    if (cue === undefined && this.clipboard.length === 0) return;

    event.preventDefault();
    this.hideContextMenu();
    const here = this.snap(this.xToTime(event.clientX, lane));
    const fixtureId = lane.closest<HTMLElement>('.fixture-row')?.dataset.fixtureId;
    const targetFixture = this.fixtures.find((fixture) => fixture.id === fixtureId) ?? null;
    const targetSurface = this.surfaceById(fixtureId ?? null);
    const targetLaneId = targetFixture?.id ?? targetSurface?.id ?? null;
    const targetLaneLabel = targetFixture !== null
      ? this.labelFor(targetFixture)
      : targetSurface?.name ?? '';

    if (cue !== undefined) {
      // Right-clicking an unselected card selects it; right-clicking inside a
      // batch keeps the batch so Copy/Delete act on the whole selection.
      if (!this.selectedCueIds.has(cue.id)) {
        this.selectedCueIds.clear();
        this.selectedCueIds.add(cue.id);
        this.selectedFixtureId = cue.fixtureId;
        this.renderRows();
      }
      this.notifySelection();
    }

    const menu = document.createElement('div');
    menu.className = 'arrangement-context-menu';
    menu.setAttribute('role', 'menu');

    const item = (
      label: string,
      /** Paste target time, or `null` for a plain command. */
      time: number | null,
      run: () => void,
      options: {
        disabled?: boolean;
        title?: string;
        targetFixtureId?: string | null;
        /** Right-hand shortcut label for commands without a time. */
        hint?: string;
      } = {},
    ): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      if (options.disabled === true) {
        button.disabled = true;
        button.title = options.title ?? '';
      }
      const text = document.createElement('span');
      text.textContent = label;
      const meta = document.createElement('span');
      meta.className = 'menu-time';
      meta.textContent = options.hint ?? (time === null ? '' : formatClockLabel(time));
      button.append(text, meta);
      button.addEventListener('click', () => {
        this.hideContextMenu();
        run();
      });
      // Hovering a paste item moves the dashed preview to that target so the
      // user sees exactly where the block will land before committing.
      if (time !== null) {
        button.addEventListener('mouseenter', () => {
          this.pastePreview = {
            anchorSec: time,
            targetFixtureId: options.targetFixtureId ?? null,
          };
          this.scheduleDraw();
        });
      }
      menu.appendChild(button);
    };

    const count = this.selectedCueIds.size;
    if (cue !== undefined && count > 0) {
      item(count > 1 ? `Copy ${count} clips` : 'Copy clip', null, () => {
        this.copySelected();
        this.notifySelection();
      }, { hint: 'Ctrl/⌘ C' });
      item(count > 1 ? `Delete ${count} clips` : 'Delete clip', null, () => this.deleteSelected(), {
        hint: 'Del',
      });
    }

    if (this.clipboard.length > 0 && targetLaneId !== null) {
      if (cue !== undefined) {
        const separator = document.createElement('div');
        separator.className = 'menu-separator';
        menu.appendChild(separator);
      }
      // "Here" is the clicked row and pointer time; there is no separate
      // playhead or other-track target.
      const compatible = this.canPasteOn(targetLaneId);
      item('Paste here', here, () => this.paste(here, targetLaneId), {
        disabled: !compatible,
        title: compatible
          ? `Paste on ${targetLaneLabel}`
          : 'This track cannot play the copied clip',
        targetFixtureId: targetLaneId,
      });
      this.pastePreview = { anchorSec: here, targetFixtureId: targetLaneId };
      this.scheduleDraw();
    }

    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.appendChild(menu);
    this.contextMenu = menu;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${clamp(event.clientX, 4, window.innerWidth - rect.width - 4)}px`;
    menu.style.top = `${clamp(event.clientY, 4, window.innerHeight - rect.height - 4)}px`;
  }

  private hideContextMenu(): void {
    this.contextMenu?.remove();
    this.contextMenu = null;
    if (this.pastePreview !== null) {
      this.pastePreview = null;
      this.scheduleDraw();
    }
  }

  /** Cues whose cards intersect the client-space rubber band. */
  private marqueeSelection(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    base: ReadonlySet<string>,
  ): Set<string> {
    const selected = new Set(base);
    const pps = this.pixelsPerSecond;
    const left = Math.min(startX, endX);
    const right = Math.max(startX, endX);
    const top = Math.min(startY, endY);
    const bottom = Math.max(startY, endY);
    for (const row of this.root.querySelectorAll<HTMLElement>('.fixture-row')) {
      const lane = row.querySelector<HTMLElement>('.fixture-lane');
      const fixtureId = row.dataset.fixtureId;
      if (lane === null || fixtureId === undefined) continue;
      const laneRect = lane.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (rowRect.bottom < top || rowRect.top > bottom) continue;
      if (laneRect.right < left || laneRect.left > right) continue;
      const from = Math.max(0, (left - laneRect.left) / pps);
      const to = (right - laneRect.left) / pps;
      for (const cue of this.cues) {
        if (cue.fixtureId !== fixtureId) continue;
        if (cue.endSec > from && cue.startSec < to) selected.add(cue.id);
      }
    }
    return selected;
  }

  /** Lane under the pointer, or `null` when the pointer is off the lanes. */
  private laneIdAt(target: EventTarget | null): string | null {
    if (!(target instanceof HTMLElement)) return null;
    const lane = target.closest<HTMLElement>('.fixture-lane');
    return lane?.closest<HTMLElement>('.fixture-row')?.dataset.fixtureId ?? null;
  }

  /**
   * Target lane for each dragged cue when the pointer is over `hoveredLaneId`.
   * The grabbed cue lands on that row and the rest keep their relative track
   * offsets. If any cue cannot fit its shifted row (say a batch spanning two
   * fixture kinds), every cue stays on its original row so the batch is never
   * split across incompatible tracks.
   */
  private moveManyLaneTargets(
    gesture: Extract<Gesture, { type: 'move-many' }>,
    hoveredLaneId: string,
  ): Map<string, string> {
    const lanes = laneOrder(this.visibleFixtures(), this.visibleSurfaces());
    const anchorIndex = lanes.indexOf(gesture.anchorLaneId);
    const targetIndex = lanes.indexOf(hoveredLaneId);
    const shift = anchorIndex < 0 || targetIndex < 0 ? 0 : targetIndex - anchorIndex;
    const originals = new Map(gesture.items.map((item) => [item.cueId, item.fixtureId]));
    const targets = new Map<string, string>();
    for (const item of gesture.items) {
      const sourceIndex = lanes.indexOf(item.fixtureId);
      const targetId = shift === 0 ? item.fixtureId : lanes[sourceIndex + shift];
      const cue = this.cues.find((entry) => entry.id === item.cueId);
      if (targetId === undefined || cue === undefined
        || !canMoveCueToLane(cue, targetId, this.fixtures, this.surfaces)) {
        return originals;
      }
      targets.set(item.cueId, targetId);
    }
    return targets;
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

    if (gesture.type === 'move-many') {
      // Every lane shares the same horizontal scale, so any lane maps the
      // pointer to song time even when a moved track is filtered out.
      const target = event.target;
      const lane = (target instanceof HTMLElement ? target.closest<HTMLElement>('.fixture-lane') : null)
        ?? this.root.querySelector<HTMLElement>('.fixture-lane');
      if (lane === null) return;
      // Dragging over another row retargets the batch; the grabbed cue lands
      // on that row and the rest keep their relative track offsets.
      const hoveredLaneId = this.laneIdAt(target);
      const laneTargets = hoveredLaneId === null
        ? null
        : this.moveManyLaneTargets(gesture, hoveredLaneId);
      const rawDelta = this.xToTime(event.clientX, lane) - gesture.anchorSec;
      const minStart = Math.min(...gesture.items.map((item) => item.startSec));
      const maxEnd = Math.max(...gesture.items.map((item) => item.startSec + item.durationSec));
      // Snap the movement itself, then clamp so the whole block stays in song.
      const delta = clamp(
        this.snapDelta(rawDelta),
        -minStart,
        Math.max(-minStart, this.timeline.durationSec - maxEnd),
      );
      const moving = new Map(gesture.items.map((item) => [item.cueId, item]));
      this.cues = this.cues.map((cue) => {
        const item = moving.get(cue.id);
        if (item === undefined) return cue;
        const startSec = item.startSec + delta;
        const fixtureId = laneTargets?.get(cue.id) ?? cue.fixtureId;
        return {
          ...cue,
          fixtureId,
          ...(cue.surfaceId === undefined ? {} : { surfaceId: fixtureId }),
          startSec,
          endSec: startSec + item.durationSec,
        };
      });
      this.scheduleDraw();
      return;
    }

    if (gesture.type === 'marquee') {
      this.showMarquee(event.clientX, event.clientY);
      const ids = this.marqueeSelection(
        gesture.startX,
        gesture.startY,
        event.clientX,
        event.clientY,
        gesture.base,
      );
      this.selectedCueIds.clear();
      for (const id of ids) this.selectedCueIds.add(id);
      this.scheduleDraw();
      return;
    }

    const cue = this.cues.find((item) => item.id === gesture.cueId);
    if (cue === undefined) return;
    const lane = this.root.querySelector<HTMLElement>(`[data-fixture-id="${CSS.escape(cue.fixtureId)}"] .fixture-lane`);
    if (lane === null) return;
    const time = this.snap(this.xToTime(event.clientX, lane));
    if (gesture.type === 'move') {
      // Cross-track drag: move the clip onto the row under the pointer when
      // that row can perform the clip's controls. Incompatible rows are
      // ignored, so the clip stays on its last valid track.
      const hoveredLaneId = this.laneIdAt(event.target);
      if (hoveredLaneId !== null && hoveredLaneId !== cue.fixtureId
        && canMoveCueToLane(cue, hoveredLaneId, this.fixtures, this.surfaces)) {
        this.cues = this.cues.map((item) => item.id === cue.id
          ? {
              ...item,
              fixtureId: hoveredLaneId,
              ...(item.surfaceId === undefined ? {} : { surfaceId: hoveredLaneId }),
            }
          : item);
      }
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
    this.hideMarquee();
    if (gesture.type === 'marquee') {
      this.renderRows();
      this.notifySelection();
      return;
    }
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
    this.hideMarquee();
    this.renderRows();
  }

  /**
   * Allocate an unused cue id. Loading a project used to restart the counter,
   * so a new clip could reuse an id that an existing clip already owned; that
   * made a gesture move every cue sharing the id.
   */
  private nextCueId(): string {
    const used = new Set(this.cues.map((cue) => cue.id));
    let id = `cue-${this.nextId++}`;
    while (used.has(id)) id = `cue-${this.nextId++}`;
    return id;
  }

  private createCue(fixtureId: string, startSec: number, action: CueAction, requestedEnd?: number): void {
    const duration = this.timeline?.durationSec ?? 0;
    const endSec = Math.min(duration, Math.max(startSec + MIN_CLIP_SEC, requestedEnd ?? startSec + this.defaultLength()));
    if (endSec - startSec < MIN_CLIP_SEC) return;
    const surface = this.surfaceById(fixtureId);
    const cue: Cue = surface === null
      ? {
          id: this.nextCueId(),
          fixtureId,
          startSec,
          endSec,
          colorIndex: this.suggestedColorIndex,
          action,
          ...(action === 'sweep' ? { sweep: { hz: sweepRateForLength(endSec - startSec) } } : {}),
          ...(this.pendingColorOverride === null ? {} : { colorOverride: this.pendingColorOverride }),
        }
      : {
          id: this.nextCueId(),
          fixtureId,
          surfaceId: surface.id,
          startSec,
          endSec,
          colorIndex: 0,
          action,
          look: this.suggestedLook,
          opacity: 1,
        };
    this.pushHistory();
    this.cues = [...this.cues, cue];
    this.selectedFixtureId = fixtureId;
    this.selectedCueIds.clear();
    this.selectedCueIds.add(cue.id);
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  private pointerHover(event: PointerEvent): void {
    const hoverTarget = event.target;
    const hoverLane = hoverTarget instanceof HTMLElement
      ? hoverTarget.closest<HTMLElement>('.fixture-lane')
      : null;
    const hoverFixtureId = hoverLane?.closest<HTMLElement>('.fixture-row')?.dataset.fixtureId ?? null;
    const previousTime = this.pointerTimeSec;
    const previousFixtureId = this.pointerFixtureId;
    this.pointerTimeSec = hoverLane === null || this.timeline === null
      ? null
      : this.xToTime(event.clientX, hoverLane);
    this.pointerFixtureId = this.pointerTimeSec === null ? null : hoverFixtureId;

    // The select-mode paste marker follows the grid, not the raw pointer, so
    // only repaint when the snapped cell or hovered track changes.
    const nextTime = this.pointerTimeSec;
    const movedCell = (previousTime === null) !== (nextTime === null)
      || (previousTime !== null && nextTime !== null && this.snap(previousTime) !== this.snap(nextTime));
    if (this.mode === 'select' && (movedCell || previousFixtureId !== this.pointerFixtureId)) {
      this.scheduleDraw();
    }

    if (this.mode === 'select') {
      // No draw-a-clip ghost while selecting: it would advertise a gesture
      // that select mode deliberately does not perform.
      this.hideHover();
      this.setHoveredCue(hoverTarget instanceof HTMLElement
        ? hoverTarget.closest<HTMLElement>('.arrangement-clip')?.dataset.cueId ?? null
        : null);
      return;
    }
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
    const surface = this.surfaceById(fixtureId ?? null);
    if (lane === null || (fixture === undefined && surface === null)) {
      this.hideHover();
      return;
    }

    const startSec = this.snap(this.xToTime(event.clientX, lane));
    const length = Math.max(MIN_CLIP_SEC, Math.min(
      this.defaultLength(),
      this.timeline.durationSec - startSec,
    ));
    const action = surface !== null
      ? lookDefinition(this.suggestedLook.kind).label
      : this.defaultAction(fixture!);

    let ghost = this.hoverGhost;
    if (ghost === null || !ghost.isConnected) {
      ghost = document.createElement('div');
      ghost.className = 'arrangement-ghost';
      this.hoverGhost = ghost;
    }
    if (ghost.parentElement !== lane) lane.appendChild(ghost);
    ghost.style.left = `${startSec * this.pixelsPerSecond}px`;
    ghost.style.width = `${Math.max(2, length * this.pixelsPerSecond)}px`;
    ghost.textContent = action;
  }

  private hideHover(): void {
    this.hoverGhost?.remove();
    this.hoverGhost = null;
  }

  private renderRows(): void {
    const timeline = this.timeline;
    if (timeline === null) return;
    this.hoverGhost = null;
    this.root.dataset.grid = gridModeFor(timeline, this.pixelsPerSecond);
    this.root.innerHTML = buildRowsMarkup({
      fixtures: this.visibleFixtures(),
      surfaces: this.visibleSurfaces(),
      cues: this.cues,
      timeline,
      pixelsPerSecond: this.pixelsPerSecond,
      activeFixtureId: this.activeFixtureId,
      hiddenFixtureIds: this.hiddenFixtureIds,
      labelFor: (fixture) => this.labelFor(fixture),
      subtitleFor: (fixture) =>
        this.subtitleResolver?.(fixture)
        ?? `${kindLabel(fixture.profile.kind)} · ${capabilitySummary(fixture)}`,
    });
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

    paintClipOverlay(ctx, {
      width,
      height,
      pixelsPerSecond: this.pixelsPerSecond,
      scrollLeft,
      visibleFixtures: this.visibleFixtures(),
      visibleSurfaces: this.visibleSurfaces(),
      cues: this.cues,
      hiddenFixtureIds: this.hiddenFixtureIds,
      selectedCueIds: this.selectedCueIds,
      hoveredCueId: this.hoveredCueId,
      preview: this.preview,
      pastePreview: this.pastePreview,
      pointerTimeSec: this.pointerTimeSec,
      pointerFixtureId: this.pointerFixtureId,
      mode: this.mode,
      gestureActive: this.gesture !== null,
      canPaste: this.canPaste,
      clipboardLength: this.clipboard.length,
      snap: (timeSec) => this.snap(timeSec),
      resolvePastePlacements: (atSec, targetFixtureId) =>
        this.pastePlacements(atSec, targetFixtureId),
    });
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

  private notifyChange(): void {
    this.onChange(this.cues);
  }

  private snapshot(): CueSnapshot {
    return {
      cues: this.cues.map((cue) => cloneCue(cue)),
      selectedCueIds: [...this.selectedCueIds],
    };
  }

  /** Record the current state as an undo step and drop any redo branch. */
  private pushHistory(): void {
    this.pushSnapshot(this.snapshot());
  }

  private pushSnapshot(snapshot: CueSnapshot): void {
    this.history.push(snapshot);
  }

  private clearHistory(): void {
    this.history.clear();
  }

  private restore(snapshot: CueSnapshot): void {
    this.cues = snapshot.cues.map((cue) => cloneCue(cue));
    const existing = new Set(this.cues.map((cue) => cue.id));
    this.selectedCueIds.clear();
    for (const id of snapshot.selectedCueIds) {
      if (existing.has(id)) this.selectedCueIds.add(id);
    }
    this.preview = null;
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  private notifySelection(): void {
    this.onSelection(this.selectedFixture, this.selectedCues, this.selectedSurface);
  }

  private defaultLength(): number {
    return defaultClipLength(this.timeline);
  }

  private defaultAction(fixture: FixturePlacement): CueAction {
    if (this.pendingAction !== null && actionsFor(fixture).includes(this.pendingAction)) {
      return this.pendingAction;
    }
    if (fixture.profile.kind === 'cryo-jet') return 'fire';
    return fixture.profile.capabilities.panTilt ? 'sweep' : fixture.profile.capabilities.strobe ? 'strobe' : 'hold';
  }

  /** Snap a movement delta (rather than an absolute time) to the grid. */
  private snapDelta(deltaSec: number): number {
    return snapDeltaToGrid(this.timeline, deltaSec);
  }

  private snap(timeSec: number): number {
    return snapTime(this.timeline, timeSec);
  }

  private xToTime(clientX: number, lane: HTMLElement): number {
    return (clientX - lane.getBoundingClientRect().left) / this.pixelsPerSecond;
  }
}

/**
 * Give every cue a unique id and report the next free `cue-N` counter.
 *
 * Cue ids are the identity used by selection, gestures and delete, and gestures
 * rewrite every cue whose id matches. Ids must therefore be unique. A session
 * used to restart its counter when a project loaded, so a newly created clip
 * could take an id a loaded clip already owned and the two then moved together.
 * Duplicates are repaired here so projects saved during that time still open.
 */
/** Deep-copy the fields a surface cue nests, so undo snapshots are isolated. */
function cloneCue(cue: Cue): Cue {
  return {
    ...cue,
    ...(cue.look === undefined
      ? {}
      : { look: { ...cue.look, colors: [...cue.look.colors] } }),
  };
}

export function reserveCueIds(cues: readonly Cue[]): { cues: Cue[]; nextId: number } {
  const used = new Set<string>();
  let nextId = 1;
  const reserved = cues.map((cue) => {
    const copy: Cue = cloneCue(cue);
    if (copy.id === '' || used.has(copy.id)) {
      let id = `cue-${nextId++}`;
      while (used.has(id)) id = `cue-${nextId++}`;
      copy.id = id;
    }
    used.add(copy.id);
    return copy;
  });
  for (const id of used) {
    const match = /^cue-(\d+)$/.exec(id);
    if (match !== null) nextId = Math.max(nextId, Number(match[1]) + 1);
  }
  return { cues: reserved, nextId };
}

/**
 * Default movement rate for a new sweep clip: one cycle across the clip.
 * Stored explicitly so a later resize keeps the same speed.
 */
function sweepRateForLength(durationSec: number): number {
  return Math.round((1 / Math.max(0.001, durationSec)) * 1000) / 1000;
}

/**
 * Dimmer keyframes for a `pulse` cue.
 *
 * Without a rate the legacy shape is kept (four pulses across the clip). With
 * `pulseHz` the clip pulses at that speed regardless of its length.
 */
function pulseKeyframes(durationSec: number, pulseHz?: number): Keyframe[] {
  if (pulseHz === undefined || pulseHz <= 0) {
    return [
      { at: 0, value: 0.9 },
      { at: 0.12, value: 0.08 },
      { at: 0.24, value: 0.9 },
      { at: 0.36, value: 0.08 },
      { at: 0.48, value: 0.9 },
      { at: 0.6, value: 0.08 },
      { at: 0.72, value: 0.9 },
      { at: 0.84, value: 0.08 },
      { at: 1, value: 0.9 },
    ];
  }
  const steps = Math.max(2, Math.round(Math.max(0.001, durationSec) * pulseHz * 2));
  const frames: Keyframe[] = [];
  for (let index = 0; index <= steps; index += 1) {
    frames.push({ at: index / steps, value: index % 2 === 0 ? 0.9 : 0.08 });
  }
  return frames;
}

/**
 * Converts one arrangement cue into the evaluator's clip form. Pure so the
 * stage and headless tests share exactly the same interpretation of a cue.
 */
export function cueToClip(fixture: FixturePlacement | undefined, cue: Cue): Clip {
  const caps = fixture?.profile.capabilities;
  const color = resolveCueColor(cue);
  const clipLength = Math.max(0.001, cue.endSec - cue.startSec);
  const attrs: Clip['attributes'] = {
    dimmer: cue.action === 'fire'
      // Brief, hard-hitting burst with a tail, the shape of a CO2 jet.
      ? [
          { at: 0, value: 0.15 },
          { at: 0.04, value: 1 },
          { at: 0.78, value: 0.85 },
          { at: 1, value: 0 },
        ]
      : cue.action === 'fade'
        ? [{ at: 0, value: 0 }, { at: 1, value: 0.9 }]
        : cue.action === 'pulse'
          ? pulseKeyframes(clipLength, cue.pulseHz)
          : [{ at: 0, value: 0.9 }],
  };

  if (caps?.color) {
    // White-temperature overrides drive the white channel on rgbw fixtures
    // (tinted rgb on top) and fall back to tinted rgb on rgb-only fixtures.
    const isWhiteOverride = cue.colorOverride?.kind === 'white';
    if (isWhiteOverride && caps.color === 'rgbw') {
      attrs.red = [{ at: 0, value: color.rgb[0] }];
      attrs.green = [{ at: 0, value: color.rgb[1] }];
      attrs.blue = [{ at: 0, value: color.rgb[2] }];
      attrs.white = [{ at: 0, value: 0.9 }];
    } else {
      attrs.red = [{ at: 0, value: color.rgb[0] }];
      attrs.green = [{ at: 0, value: color.rgb[1] }];
      attrs.blue = [{ at: 0, value: color.rgb[2] }];
    }
  }
  if (cue.action === 'sweep' && caps?.panTilt) {
    if (cue.sweep === undefined) {
      // Legacy shape for clips authored before `sweep` existed.
      attrs.pan = [{ at: 0, value: 0.15 }, { at: 0.5, value: 0.85 }, { at: 1, value: 0.15 }];
      attrs.tilt = [{ at: 0, value: 0.42 }, { at: 0.5, value: 0.66 }, { at: 1, value: 0.42 }];
    }
  }
  if (cue.action === 'strobe' && caps?.strobe) {
    /* Keep the channel value as a fallback rate; `strobe.hz` overrides it so
     * the inspector can expose an actual frequency. */
    attrs.strobe = [{ at: 0, value: 0.78 }];
  }

  return {
    id: cue.id,
    startSec: cue.startSec,
    endSec: cue.endSec,
    fadeInSec: cue.fadeInSec ?? (cue.action === 'fade' ? 0 : 0.04),
    fadeOutSec: cue.fadeOutSec ?? 0.08,
    easing: cue.action === 'sweep' ? 'sine' : cue.action === 'pulse' ? 'step' : 'linear',
    attributes: attrs,
    ...(cue.action === 'strobe' && cue.strobe !== undefined ? { strobe: cue.strobe } : {}),
    ...(cue.action === 'sweep' && cue.sweep !== undefined ? { sweep: cue.sweep } : {}),
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
      || left.fadeInSec !== right.fadeInSec
      || left.fadeOutSec !== right.fadeOutSec
      || left.pulseHz !== right.pulseHz
      || left.surfaceId !== right.surfaceId
      || JSON.stringify(left.strobe ?? null) !== JSON.stringify(right.strobe ?? null)
      || JSON.stringify(left.sweep ?? null) !== JSON.stringify(right.sweep ?? null)
      || JSON.stringify(left.look ?? null) !== JSON.stringify(right.look ?? null)
      || JSON.stringify(left.colorOverride ?? null) !== JSON.stringify(right.colorOverride ?? null)) return false;
  }
  return true;
}
