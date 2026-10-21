import {
  ProjectFileError,
  readProjectBundle,
  writeProjectBundle,
  type ProjectBundle,
  type ProjectClip,
  type ProjectFile,
  type ProjectMediaMap,
  type ProjectSurfaceClip,
} from '@dmxsim/show-model';
import type { FixturePlacement, LedSurface, Show } from '@dmxsim/show-model';
import type { Cue, CueTimeline } from './arrangement';

/** Map an authored arrangement cue into the portable project representation. */
export function cueToProjectClip(cue: Cue): ProjectClip {
  return {
    id: cue.id,
    fixtureId: cue.fixtureId,
    startSec: cue.startSec,
    endSec: cue.endSec,
    action: cue.action,
    colorIndex: cue.colorIndex,
    ...(cue.colorOverride === undefined ? {} : { colorOverride: cue.colorOverride }),
    ...(cue.fadeInSec === undefined ? {} : { fadeInSec: cue.fadeInSec }),
    ...(cue.fadeOutSec === undefined ? {} : { fadeOutSec: cue.fadeOutSec }),
    ...(cue.strobe === undefined ? {} : { strobe: cue.strobe }),
    ...(cue.pulseHz === undefined ? {} : { pulseHz: cue.pulseHz }),
    ...(cue.aim === undefined ? {} : { aim: cue.aim }),
    ...(cue.sweep === undefined ? {} : { sweep: cue.sweep }),
  };
}

/** Map a project clip into the arrangement's in-memory cue type. */
export function projectClipToCue(clip: ProjectClip): Cue {
  return {
    id: clip.id,
    fixtureId: clip.fixtureId,
    startSec: clip.startSec,
    endSec: clip.endSec,
    action: clip.action,
    colorIndex: clip.colorIndex,
    ...(clip.colorOverride === undefined ? {} : { colorOverride: clip.colorOverride }),
    ...(clip.fadeInSec === undefined ? {} : { fadeInSec: clip.fadeInSec }),
    ...(clip.fadeOutSec === undefined ? {} : { fadeOutSec: clip.fadeOutSec }),
    ...(clip.strobe === undefined ? {} : { strobe: clip.strobe }),
    ...(clip.pulseHz === undefined ? {} : { pulseHz: clip.pulseHz }),
    ...(clip.aim === undefined ? {} : { aim: clip.aim }),
    ...(clip.sweep === undefined ? {} : { sweep: clip.sweep }),
  };
}

/**
 * Surface clips are stored separately from fixture clips because they carry a
 * look instead of DMX controls. The arrangement still keys them by lane id, so
 * `fixtureId` receives the surface id here and `surfaceId` marks the kind.
 */
export function surfaceCueToProjectClip(cue: Cue): ProjectSurfaceClip {
  return {
    id: cue.id,
    surfaceId: cue.surfaceId ?? cue.fixtureId,
    startSec: cue.startSec,
    endSec: cue.endSec,
    look: cue.look!,
    opacity: cue.opacity ?? 1,
    ...(cue.fadeInSec === undefined ? {} : { fadeInSec: cue.fadeInSec }),
    ...(cue.fadeOutSec === undefined ? {} : { fadeOutSec: cue.fadeOutSec }),
  };
}

export function projectSurfaceClipToCue(clip: ProjectSurfaceClip): Cue {
  return {
    id: clip.id,
    fixtureId: clip.surfaceId,
    surfaceId: clip.surfaceId,
    startSec: clip.startSec,
    endSec: clip.endSec,
    action: 'hold',
    colorIndex: 0,
    look: clip.look,
    opacity: clip.opacity,
    ...(clip.fadeInSec === undefined ? {} : { fadeInSec: clip.fadeInSec }),
    ...(clip.fadeOutSec === undefined ? {} : { fadeOutSec: clip.fadeOutSec }),
  };
}

/** Split an in-memory cue list into the two portable clip collections. */
export function splitCues(cues: readonly Cue[]): {
  clips: ProjectClip[];
  surfaceClips: ProjectSurfaceClip[];
} {
  return {
    clips: cues.filter((cue) => cue.surfaceId === undefined).map(cueToProjectClip),
    surfaceClips: cues.filter((cue) => cue.surfaceId !== undefined).map(surfaceCueToProjectClip),
  };
}

/** Surfaces the project declares, or the venue's wall when it declares none. */
export function surfacesFromProject(project: ProjectFile, fallback: readonly LedSurface[]): LedSurface[] {
  return project.arrangement.surfaces.length > 0
    ? project.arrangement.surfaces
    : [...fallback];
}

/** The project timeline is authoritative for the beat grid and loop. */
export function cueTimelineFromProject(project: ProjectFile): CueTimeline {
  const { durationSec, beatGrid, loop } = project.timeline;
  return {
    durationSec,
    firstBeatSec: beatGrid.offsetSec,
    bpm: beatGrid.bpm,
    beatsPerBar: beatGrid.beatsPerBar,
    loopStartSec: loop.startSec,
    loopEndSec: loop.endSec,
  };
}

/**
 * Build the renderer's `Show` document from the project rig. The project
 * timeline owns the editable beat grid; `Show.beatGrid` is only used by the
 * stats readout, so it receives a safe fallback when no tempo is known.
 */
export function showFromProject(project: ProjectFile): Show {
  const { beatGrid } = project.timeline;
  return {
    version: 1,
    name: project.show.name,
    beatGrid: {
      bpm: beatGrid.bpm ?? 120,
      offsetSec: beatGrid.offsetSec,
      beatsPerBar: beatGrid.beatsPerBar,
    },
    fixtures: project.show.fixtures as FixturePlacement[],
    tracks: project.show.tracks,
  };
}

export function fixtureIds(project: ProjectFile): string[] {
  return project.show.fixtures.map((fixture) => fixture.id);
}

/**
 * Copy saved fixture state onto the running rig.
 *
 * A version 2 project stores the mount, the friendly name, and laser setup as
 * well as the resolved transform. Restoring all of it keeps Open project
 * lossless; M3's rig editor replaces this function once fixtures are rebuilt
 * from the file instead of mutated in place.
 */
export function applyProjectFixtureSetup(project: ProjectFile, fixtures: readonly FixturePlacement[]): void {
  const saved = new Map(project.show.fixtures.map((fixture) => [fixture.id, fixture]));
  for (const fixture of fixtures) {
    const source = saved.get(fixture.id);
    if (source === undefined) continue;
    fixture.yawDeg = source.yawDeg;
    fixture.position = { ...source.position };
    if (source.name === undefined) delete fixture.name;
    else fixture.name = source.name;
    if (source.pitchOffsetDeg === undefined) delete fixture.pitchOffsetDeg;
    else fixture.pitchOffsetDeg = source.pitchOffsetDeg;
    if (source.mount === undefined) delete fixture.mount;
    else fixture.mount = { ...source.mount };
    if (source.laser === undefined) delete fixture.laser;
    else fixture.laser = { ...source.laser };
    if (source.defaults === undefined) delete fixture.defaults;
    else fixture.defaults = { ...source.defaults };
  }
}

/** Clip lane order is project/fixture order, so compare as sets. */
export function rigMatches(project: ProjectFile, fixtures: readonly FixturePlacement[]): boolean {
  const a = fixtureIds(project).slice().sort();
  const b = fixtures.map((fixture) => fixture.id).slice().sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** `My Show!` -> `my-show.dmxsim` */
export function projectFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'project' : slug}.dmxsim`;
}

export async function downloadProject(project: ProjectFile, media: ProjectMediaMap): Promise<void> {
  const bytes = await writeProjectBundle(project, media);
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = projectFileName(project.name);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readProjectFile(file: File): Promise<ProjectBundle> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new ProjectFileError(`Could not read "${file.name}"`);
  }
  return readProjectBundle(data);
}
