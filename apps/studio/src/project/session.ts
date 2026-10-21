import type { ProjectBundle, ProjectFile } from '@dmxsim/show-model';
import type { EmbeddedProject } from './media';
import {
  downloadProject,
  fixtureIds,
  projectFileName,
  readProjectFile,
} from '../project-file';

export interface SaveProjectContext {
  /** `null` means the audio/timeline is not ready yet. */
  build(): ProjectFile | null;
  /** Rewrite local media refs and gather the bytes the bundle should carry. */
  embed(project: ProjectFile): Promise<EmbeddedProject>;
  setStatus(message: string): void;
}

export async function saveProject(context: SaveProjectContext): Promise<void> {
  const project = context.build();
  if (project === null) {
    context.setStatus('Load audio before saving a project');
    return;
  }
  try {
    const embedded = await context.embed(project);
    await downloadProject(embedded.project, embedded.media);
    const clipCount = project.arrangement.clips.length + project.arrangement.surfaceClips.length;
    const files = embedded.media.size;
    const shared = missingSuffix(embedded.missing);
    context.setStatus(
      `Saved ${projectFileName(project.name)} · ${clipCount} clips · ${files} media ${files === 1 ? 'file' : 'files'}${shared}`,
    );
  } catch (error) {
    console.error(`could not save project "${project.name}"`, error);
    context.setStatus(
      error instanceof Error ? `Could not save project: ${error.message}` : 'Could not save project',
    );
  }
}

function missingSuffix(missing: readonly string[]): string {
  if (missing.length === 0) return '';
  return ` · missing ${missing.join(', ')}`;
}

export interface OpenProjectContext {
  file: File;
  /** Audio must finish loading before a project can replace the timeline. */
  hasAudio(): boolean;
  rigMatches(project: ProjectFile): boolean;
  /** Receives the document and the media the bundle carried. */
  apply(bundle: ProjectBundle): void | Promise<void>;
  setBusy(busy: boolean): void;
  setStatus(message: string): void;
}

export async function openProject(context: OpenProjectContext): Promise<void> {
  const { file } = context;
  context.setBusy(true);
  context.setStatus(`Opening ${file.name}…`);
  try {
    const bundle = await readProjectFile(file);
    const embeddedAudio = bundle.project.audio.source === 'embedded'
      && bundle.project.audio.sha256 !== undefined
      && bundle.media.has(bundle.project.audio.sha256);
    if (!context.hasAudio() && !embeddedAudio) {
      context.setStatus('Load audio before opening a project');
      return;
    }
    if (!context.rigMatches(bundle.project)) {
      context.setStatus(
        `Cannot open ${file.name}: its rig (${fixtureIds(bundle.project).length} fixtures) does not match this build`,
      );
      return;
    }
    await context.apply(bundle);
    if (bundle.warnings.length > 0) {
      console.warn(`opened ${file.name} with missing media`, bundle.warnings);
    }
    // `project.name` comes from the opened file's own `name` field, so the
    // status always describes the project the user actually loaded.
    const clipCount = bundle.project.arrangement.clips.length
      + bundle.project.arrangement.surfaceClips.length;
    const warnings = bundle.warnings.length === 0 ? '' : ` · ${bundle.warnings.length} missing media`;
    context.setStatus(`Opened ${bundle.project.name} · ${clipCount} clips${warnings} · ${file.name}`);
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
