/**
 * `.dmxsim` bundle container.
 *
 * A project is one ZIP file so a show can be shared as a single attachment:
 *
 * ```
 * show.dmxsim
 *   project.json          the validated project document
 *   media/<sha256>.<ext>  audio, LED wall images and videos
 * ```
 *
 * Media is content-addressed, so two looks that use the same file store it
 * once and re-saving an unchanged file produces identical bytes. The bundle
 * only carries files the project references; `project.json` lists them in its
 * `media` manifest.
 *
 * This module is runtime-agnostic (ADR-006) so the browser and the demo
 * generator share one reader/writer.
 */

import { strFromU8, strToU8, unzip, zip, type AsyncZippable } from 'fflate';
import {
  ProjectFileError,
  parseProject,
  serializeProject,
  type ProjectFile,
  type ProjectMedia,
  type ProjectMediaKind,
} from './project';

/** Name of the project document inside the container. */
export const PROJECT_ENTRY = 'project.json';
/** Directory holding content-addressed media. */
export const MEDIA_DIR = 'media/';

/** Refuse absurd bundles before allocating for them. */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_PROJECT_JSON_BYTES = 16 * 1024 * 1024;

/** Bytes for one media file, keyed by digest in a `ProjectMediaMap`. */
export interface ProjectMediaFile {
  bytes: Uint8Array;
  kind: ProjectMediaKind;
  mime: string;
  fileName?: string;
}

/** Media carried by a bundle, keyed by SHA-256 digest. */
export type ProjectMediaMap = Map<string, ProjectMediaFile>;

export interface ProjectBundle {
  project: ProjectFile;
  media: ProjectMediaMap;
  /** Non-fatal problems, e.g. manifest entries with no bytes in the archive. */
  warnings: string[];
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** MIME type for a file name, with a generic fallback. */
export function mimeFromFileName(fileName: string, kind: ProjectMediaKind): string {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? `${kind}/octet-stream`;
}

/** Extension used for a media entry; prefers the original file's extension. */
function extensionFor(file: ProjectMediaFile): string {
  if (file.fileName !== undefined) {
    const dot = file.fileName.lastIndexOf('.');
    if (dot >= 0) {
      const extension = file.fileName.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{1,8}$/.test(extension)) return extension;
    }
  }
  return EXTENSION_BY_MIME[file.mime] ?? 'bin';
}

/** Entry name for one media file, e.g. `media/<sha>.ogg`. */
export function mediaEntryName(sha256: string, file: ProjectMediaFile): string {
  return `${MEDIA_DIR}${sha256}.${extensionFor(file)}`;
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Set of media digests a project document references.
 *
 * Saving only writes referenced files, and `writeProjectBundle` uses this to
 * prune the manifest, so a deleted look does not keep megabytes in the file.
 */
export function referencedMedia(project: ProjectFile): Set<string> {
  const digests = new Set<string>();
  if (project.audio.source === 'embedded' && project.audio.sha256 !== undefined) {
    digests.add(project.audio.sha256);
  }
  for (const clip of project.arrangement.surfaceClips) {
    const source = clip.look.media?.source;
    if (source !== undefined && source.startsWith('embedded:')) {
      digests.add(source.slice('embedded:'.length));
    }
  }
  return digests;
}

/** Manifest row for one media file. */
function manifestEntry(sha256: string, file: ProjectMediaFile): ProjectMedia {
  return {
    sha256,
    kind: file.kind,
    mime: file.mime,
    bytes: file.bytes.byteLength,
    ...(file.fileName === undefined ? {} : { fileName: file.fileName }),
  };
}

/**
 * Serialize a project and its media into bundle bytes.
 *
 * The manifest is rebuilt from `media` (pruned to the digests the document
 * references), so callers only have to supply bytes.
 */
export async function writeProjectBundle(
  project: ProjectFile,
  media: ProjectMediaMap,
): Promise<Uint8Array> {
  const referenced = referencedMedia(project);
  const files: AsyncZippable = {};
  const manifest: ProjectMedia[] = [];

  for (const sha256 of [...referenced].sort()) {
    const file = media.get(sha256);
    if (file === undefined) {
      throw new ProjectFileError(`Project references media ${sha256} that is not available`);
    }
    manifest.push(manifestEntry(sha256, file));
    files[mediaEntryName(sha256, file)] = [file.bytes, { level: 0 }];
  }

  const document: ProjectFile = { ...project, media: manifest };
  const json = strToU8(serializeProject(document));

  return new Promise((resolve, reject) => {
    zip({ ...files, [PROJECT_ENTRY]: [json, { level: 6 }] }, (error, data) => {
      if (error) reject(new ProjectFileError(`Could not write bundle: ${error.message}`));
      else resolve(data);
    });
  });
}

/** Entry names must not escape the virtual root. */
function assertSafeEntryName(name: string): void {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
    throw new ProjectFileError(`Unsafe bundle entry \`${name}\``);
  }
}

function extensionOf(name: string): string {
  const file = name.slice(name.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot < 0 ? '' : file.slice(dot + 1).toLowerCase();
}

/** Read a bundle, validating the document and collecting the files it names. */
export async function readProjectBundle(data: Uint8Array): Promise<ProjectBundle> {
  if (data.byteLength > MAX_BUNDLE_BYTES) {
    throw new ProjectFileError(`Bundle is larger than ${Math.round(MAX_BUNDLE_BYTES / 1024 / 1024)} MB`);
  }

  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(data, { filter: (file) => file.originalSize <= MAX_BUNDLE_BYTES }, (error, result) => {
      if (error) reject(new ProjectFileError(`Not a valid .dmxsim bundle: ${error.message}`));
      else resolve(result);
    });
  });

  const names = Object.keys(entries);
  if (names.length > MAX_ENTRIES) {
    throw new ProjectFileError(`Bundle has too many entries (${names.length})`);
  }
  for (const name of names) assertSafeEntryName(name);

  const projectBytes = entries[PROJECT_ENTRY];
  if (projectBytes === undefined) {
    throw new ProjectFileError(`Bundle has no \`${PROJECT_ENTRY}\``);
  }
  if (projectBytes.byteLength > MAX_PROJECT_JSON_BYTES) {
    throw new ProjectFileError(`\`${PROJECT_ENTRY}\` is unexpectedly large`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(strFromU8(projectBytes));
  } catch {
    throw new ProjectFileError(`\`${PROJECT_ENTRY}\` is not valid JSON`);
  }
  const project = parseProject(parsedJson);

  // Match archive entries to manifest digests by their `<sha>.<ext>` name.
  const byDigest = new Map<string, { bytes: Uint8Array; extension: string }>();
  for (const [name, bytes] of Object.entries(entries)) {
    if (!name.startsWith(MEDIA_DIR)) continue;
    const file = name.slice(MEDIA_DIR.length);
    const sha256 = file.slice(0, file.lastIndexOf('.'));
    if (!/^[0-9a-f]{64}$/.test(sha256)) continue;
    byDigest.set(sha256, { bytes, extension: extensionOf(name) });
  }

  const media: ProjectMediaMap = new Map();
  const warnings: string[] = [];
  for (const entry of project.media) {
    const found = byDigest.get(entry.sha256);
    if (found === undefined) {
      warnings.push(`Missing media \`${entry.fileName ?? entry.sha256}\` from the bundle`);
      continue;
    }
    media.set(entry.sha256, {
      bytes: found.bytes,
      kind: entry.kind,
      mime: entry.mime,
      ...(entry.fileName === undefined ? {} : { fileName: entry.fileName }),
    });
  }

  return { project, media, warnings };
}
