import type { ProjectFile } from '@dmxsim/show-model';
import {
  downloadProject,
  fixtureIds,
  projectFileName,
  readProjectFile,
} from '../project-file';

export interface SaveProjectContext {
  /** `null` means the audio/timeline is not ready yet. */
  build(): ProjectFile | null;
  setStatus(message: string): void;
}

export function saveProject(context: SaveProjectContext): void {
  const project = context.build();
  if (project === null) {
    context.setStatus('Load audio before saving a project');
    return;
  }
  downloadProject(project);
  const clipCount = project.arrangement.clips.length + project.arrangement.surfaceClips.length;
  context.setStatus(`Saved ${projectFileName(project.name)} · ${clipCount} clips`);
}

export interface OpenProjectContext {
  file: File;
  /** Audio must finish loading before a project can replace the timeline. */
  hasAudio(): boolean;
  rigMatches(project: ProjectFile): boolean;
  apply(project: ProjectFile): void;
  setBusy(busy: boolean): void;
  setStatus(message: string): void;
}

export async function openProject(context: OpenProjectContext): Promise<void> {
  const { file } = context;
  context.setBusy(true);
  context.setStatus(`Opening ${file.name}…`);
  try {
    const project = await readProjectFile(file);
    if (!context.hasAudio()) {
      context.setStatus('Load audio before opening a project');
      return;
    }
    if (!context.rigMatches(project)) {
      context.setStatus(
        `Cannot open ${file.name}: its rig (${fixtureIds(project).length} fixtures) does not match this build`,
      );
      return;
    }
    context.apply(project);
    // `project.name` comes from the opened file's own `name` field, so the
    // status always describes the project the user actually loaded.
    const clipCount = project.arrangement.clips.length + project.arrangement.surfaceClips.length;
    context.setStatus(`Opened ${project.name} · ${clipCount} clips · ${file.name}`);
  } catch (error) {
    console.error(`could not open project "${file.name}"`, error);
    context.setStatus(
      error instanceof Error
        ? `Could not open ${file.name}: ${error.message}`
        : `Could not open ${file.name}`,
    );
  } finally {
    context.setBusy(false);
  }
}
