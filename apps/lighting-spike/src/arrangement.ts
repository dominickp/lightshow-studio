import type { Clip, FixturePlacement } from '@dmxsim/show-model';

export const CUE_COLORS = [
  { name: 'blue', css: '#397cff', rgb: [0.08, 0.35, 1] },
  { name: 'violet', css: '#8c35ff', rgb: [0.55, 0.08, 1] },
  { name: 'magenta', css: '#ff3380', rgb: [1, 0.1, 0.5] },
  { name: 'cyan', css: '#16d9cc', rgb: [0.05, 0.85, 0.8] },
  { name: 'amber', css: '#ff8a18', rgb: [1, 0.42, 0.05] },
] as const;

export type CueAction = 'hold' | 'fade' | 'pulse' | 'sweep' | 'strobe';

export interface Cue {
  id: string;
  fixtureId: string;
  startSec: number;
  endSec: number;
  colorIndex: number;
  action: CueAction;
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
const MIN_CLIP_SEC = 0.1;
const EDGE_GRAB_PX = 8;

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
  private gesture: Gesture | null = null;
  private nextId = 1;
  private songTime = 0;
  private pixelsPerSecond = PIXELS_PER_SECOND;
  private pendingAction: CueAction | null = null;
  private pendingColorIndex: number | null = null;
  private preview: { fixtureId: string; startSec: number; endSec: number } | null = null;

  constructor(
    private readonly root: HTMLElement,
    fixtures: FixturePlacement[],
    private readonly onChange: (cues: readonly Cue[]) => void,
    private readonly onSelection: (fixture: FixturePlacement | null, cue: Cue | null) => void,
  ) {
    this.fixtures = fixtures;
    this.root.addEventListener('pointerdown', (event) => this.pointerDown(event));
    window.addEventListener('pointermove', (event) => this.pointerMove(event));
    window.addEventListener('pointerup', (event) => this.pointerUp(event));
    window.addEventListener('pointercancel', () => this.cancelGesture());
  }

  get selectedFixture(): FixturePlacement | null {
    return this.fixtures.find((fixture) => fixture.id === this.selectedFixtureId) ?? null;
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
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  /** Update the loop markers without clearing authored clips. */
  setLoop(startSec: number, endSec: number): void {
    if (this.timeline === null) return;
    this.timeline = { ...this.timeline, loopStartSec: startSec, loopEndSec: endSec };
    this.renderRows();
  }

  setSongTime(songTime: number): void {
    this.songTime = songTime;
    const x = `${this.songTime * this.pixelsPerSecond}px`;
    for (const playhead of this.root.querySelectorAll<HTMLElement>('.arrangement-playhead')) {
      playhead.style.left = x;
    }
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
    this.cues = this.cues.map((item) => item.id === cue.id ? { ...item, action } : item);
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  setSelectedColor(colorIndex: number): void {
    const cue = this.selectedCue;
    if (cue === null || !this.selectedFixture?.profile.capabilities.color) return;
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
    this.cues = this.cues.filter((cue) => cue.id !== this.selectedCueId);
    this.selectedCueId = null;
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  toClip(cue: Cue): Clip {
    const fixture = this.fixtures.find((item) => item.id === cue.fixtureId);
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
      fadeInSec: cue.action === 'fade' ? 0 : 0.04,
      fadeOutSec: cue.action === 'fade' ? 0.08 : 0.08,
      easing: cue.action === 'sweep' ? 'sine' : cue.action === 'pulse' ? 'step' : 'linear',
      attributes: attrs,
    };
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
    this.selectedFixtureId = fixtureId;
    if (target.closest('.track-name') !== null) {
      this.selectedCueId = null;
      this.renderRows();
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
    } else {
      const time = this.snap(this.xToTime(event.clientX, lane));
      this.selectedCueId = null;
      this.gesture = { type: 'create', fixtureId, startSec: time, currentSec: time };
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
      this.renderRows();
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
    this.renderRows();
  }

  private pointerUp(_event: PointerEvent): void {
    const gesture = this.gesture;
    if (gesture === null) return;
    this.gesture = null;
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
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  private cancelGesture(): void {
    if (this.gesture === null) return;
    this.gesture = null;
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
    this.cues = [...this.cues, cue];
    this.selectedFixtureId = fixtureId;
    this.selectedCueId = cue.id;
    this.renderRows();
    this.notifyChange();
    this.notifySelection();
  }

  private renderRows(): void {
    const timeline = this.timeline;
    if (timeline === null) return;
    const secondsWidth = timeline.durationSec * this.pixelsPerSecond;
    const beatWidth = timeline.bpm !== null && timeline.bpm > 0
      ? (60 / timeline.bpm) * this.pixelsPerSecond
      : null;
    const rows = this.fixtures.map((fixture) => {
      const selected = fixture.id === this.selectedFixtureId;
      const clips = this.cues
        .filter((cue) => cue.fixtureId === fixture.id)
        .map((cue) => {
          const color = CUE_COLORS[cue.colorIndex % CUE_COLORS.length] ?? CUE_COLORS[0];
          const selectedCue = cue.id === this.selectedCueId;
          const left = cue.startSec * this.pixelsPerSecond;
          const width = (cue.endSec - cue.startSec) * this.pixelsPerSecond;
          return `<div class="arrangement-clip${selectedCue ? ' selected' : ''}" data-cue-id="${cue.id}" style="left:${left}px;width:${width}px;--clip-color:${color.css}" title="${cue.action} · ${color.name}">
            <span class="clip-resize start"></span><span class="clip-label">${cue.action} · ${color.name}</span><span class="clip-resize end"></span>
          </div>`;
        }).join('');
      const ghost = this.preview !== null && this.preview.fixtureId === fixture.id
        ? `<div class="arrangement-clip preview" style="left:${this.preview.startSec * this.pixelsPerSecond}px;width:${Math.max(2, (this.preview.endSec - this.preview.startSec) * this.pixelsPerSecond)}px"></div>`
        : '';
      const gridStyle = beatWidth === null
        ? ''
        : `--sixteenth-width:${beatWidth / 4}px;--beat-width:${beatWidth}px;--bar-width:${beatWidth * timeline.beatsPerBar}px;`;
      const loopMarkup = this.loopMarkup(timeline, secondsWidth);
      return `<div class="fixture-row${selected ? ' selected' : ''}" data-fixture-id="${fixture.id}">
        <button type="button" class="track-name" title="${fixture.profile.name}">
          <span class="track-indicator" style="--track-color:${this.trackColor(fixture)}"></span>
          <span class="track-copy"><b>${fixture.id}</b><small>${this.kindLabel(fixture.profile.kind)} · ${this.capabilitySummary(fixture)}</small></span>
        </button>
        <div class="fixture-lane" style="width:${secondsWidth}px;${gridStyle}">
          ${loopMarkup}${clips}${ghost}<span class="arrangement-playhead" style="left:${this.songTime * this.pixelsPerSecond}px"></span>
        </div>
      </div>`;
    }).join('');
    this.root.innerHTML = rows;
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
    ctx.fillStyle = '#aeb8ca';
    ctx.fillText(String(bar + 1), x + 4, 8);
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
