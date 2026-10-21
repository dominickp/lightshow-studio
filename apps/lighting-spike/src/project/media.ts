import {
  sha256Hex,
  type ProjectFile,
  type ProjectMediaFile,
  type ProjectMediaMap,
} from '@dmxsim/show-model';

/**
 * Where the bytes for referenced media come from at save time.
 *
 * Audio is a single current track; wall media may live in the upload library
 * (IndexedDB) under a `local:` source or in the library's bundle registry
 * under `embedded:`. Bundled app media is already shipped with the app and
 * stays a `bundled:` reference, so it is never copied.
 */
export interface ProjectMediaSource {
  audio(): Promise<ProjectMediaFile | null>;
  file(source: string): Promise<ProjectMediaFile | null>;
}

export interface EmbeddedProject {
  /** Copy with every shareable media reference rewritten to `embedded:<sha>`. */
  project: ProjectFile;
  media: ProjectMediaMap;
  /** Labels of files that could not be read; the project keeps its old ref. */
  missing: string[];
}

/**
 * Turn the in-memory project into a self-contained one.
 *
 * Uploaded wall files become content-addressed `embedded:<sha256>` refs and
 * the current audio becomes an embedded track. The returned project is a
 * clone, so the running session keeps its `local:` references and remains
 * editable without reloading the assets from the bundle.
 */
export async function embedProjectMedia(
  project: ProjectFile,
  source: ProjectMediaSource,
): Promise<EmbeddedProject> {
  const next = structuredClone(project);
  const media: ProjectMediaMap = new Map();
  const missing: string[] = [];
  const hashes = new Map<string, string>();

  const add = async (file: ProjectMediaFile): Promise<string> => {
    const sha256 = await sha256Hex(file.bytes);
    if (!media.has(sha256)) media.set(sha256, file);
    return sha256;
  };

  if (next.audio.source !== 'bundled') {
    const file = await source.audio();
    if (file === null) {
      if (next.audio.source === 'embedded') {
        missing.push(next.audio.fileName ?? 'the audio track');
      }
    } else {
      const sha256 = await add(file);
      next.audio = { ...next.audio, source: 'embedded', sha256 };
    }
  }

  for (const clip of next.arrangement.surfaceClips) {
    const ref = clip.look.media;
    if (ref === undefined) continue;
    if (!ref.source.startsWith('local:') && !ref.source.startsWith('embedded:')) continue;
    const cached = hashes.get(ref.source);
    if (cached !== undefined) {
      ref.source = `embedded:${cached}`;
      continue;
    }
    const file = await source.file(ref.source);
    if (file === null) {
      missing.push(ref.label ?? ref.source);
      continue;
    }
    const sha256 = await add(file);
    hashes.set(ref.source, sha256);
    ref.source = `embedded:${sha256}`;
    if (file.fileName !== undefined && ref.label === undefined) ref.label = file.fileName;
  }

  return { project: next, media, missing };
}
