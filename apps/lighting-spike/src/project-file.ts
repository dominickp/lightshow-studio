import {
  ProjectFileError,
  parseProject,
  serializeProject,
  type ProjectClip,
  type ProjectFile,
} from '@dmxsim/show-model';
import type { FixturePlacement, Show } from '@dmxsim/show-model';
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
    ...(cue.fadeInSec === undefined ? {} : { fadeInSec: cue.fadeInSec }),
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
    ...(clip.fadeInSec === undefined ? {} : { fadeInSec: clip.fadeInSec }),
  };
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

export function downloadProject(project: ProjectFile): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = projectFileName(project.name);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readProjectFile(file: File): Promise<ProjectFile> {
  const text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProjectFileError(`"${file.name}" is not valid JSON`);
  }
  return parseProject(json);
}
