import * as THREE from 'three/webgpu';
import type { LedMediaFit, LedMediaKind, LedMediaRef } from '@dmxsim/show-model';
import type { LedMediaRuntime } from './led-wall';

/** A selectable wall source, either shipped with the app or uploaded. */
export interface LedMediaAsset {
  /** Namespaced project reference (`bundled:<id>` / `local:<uuid>`). */
  source: string;
  label: string;
  kind: LedMediaKind;
  /** Playable/loadable URL (dev-server asset or blob URL). */
  url: string;
}

const bundledUrls = import.meta.glob('./pre-generated/*.mp4', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const assetName = (path: string): string => path.split('/').at(-1) ?? path;

/**
 * The Mantissa loops are named `mantissa.xyz loop 003_x264.mp4`, so the loop
 * number is the useful identifier and label.
 */
function bundledAsset(path: string, url: string): LedMediaAsset {
  const file = assetName(path);
  const match = /loop\s+(\d+)/i.exec(file);
  const id = match?.[1] ?? file.replace(/\.[^.]+$/, '');
  const label = match === null ? file : `Mantissa ${match[1]}`;
  return { source: `bundled:${id}`, label, kind: 'video', url };
}

/** Clips shipped with the app. Nothing loads until a look references one. */
export const BUNDLED_MEDIA: readonly LedMediaAsset[] = Object.entries(bundledUrls)
  .map(([path, url]) => bundledAsset(path, url))
  .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));

/** Build the portable reference stored inside a look. */
export function mediaRef(asset: LedMediaAsset, fit: LedMediaFit = 'cover'): LedMediaRef {
  return { source: asset.source, kind: asset.kind, fit, label: asset.label };
}

interface MediaEntry {
  asset: LedMediaAsset;
  texture: THREE.Texture;
  video: HTMLVideoElement | null;
  ready: boolean;
}

interface StoredAsset {
  id: string;
  name: string;
  type: string;
  blob: Blob;
}

/* --- IndexedDB ------------------------------------------------------------ */

const DB_NAME = 'dmxsim-media';
const DB_VERSION = 1;
const STORE = 'assets';

const hasIndexedDb = (): boolean => typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open media store'));
  });
}

async function saveAsset(id: string, file: File): Promise<void> {
  if (!hasIndexedDb()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put({
        id,
        name: file.name,
        type: file.type,
        blob: file,
      } satisfies StoredAsset);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('media save failed'));
    });
  } finally {
    db.close();
  }
}

async function loadAsset(id: string): Promise<StoredAsset | null> {
  if (!hasIndexedDb()) return null;
  const db = await openDb();
  try {
    return await new Promise<StoredAsset | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      request.onsuccess = () => resolve((request.result as StoredAsset | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('media load failed'));
    });
  } finally {
    db.close();
  }
}

async function listAssets(): Promise<StoredAsset[]> {
  if (!hasIndexedDb()) return [];
  const db = await openDb();
  try {
    return await new Promise<StoredAsset[]>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as StoredAsset[] | undefined) ?? []);
      request.onerror = () => reject(request.error ?? new Error('media list failed'));
    });
  } finally {
    db.close();
  }
}

/* --- Library -------------------------------------------------------------- */

/**
 * Wall media library.
 *
 * Textures are created lazily and synchronously where possible, because the
 * renderer builds a material the first frame a clip appears. Bundled clips and
 * files uploaded this session therefore exist immediately; a `local:` source
 * restored from a saved project is fetched from IndexedDB in the background
 * and the wall rebuilds when it lands.
 */
export class LedMediaLibrary implements LedMediaRuntime {
  private readonly entries = new Map<string, MediaEntry>();
  private readonly localAssets = new Map<string, LedMediaAsset>();
  private readonly hydrating = new Set<string>();
  private readonly listeners = new Set<() => void>();

  /** Subscribe to texture-ready events (the stage rebuilds media materials). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  texture(source: string): THREE.Texture | null {
    const existing = this.entries.get(source);
    if (existing !== undefined) return existing.texture;
    if (source.startsWith('bundled:')) {
      const asset = BUNDLED_MEDIA.find((entry) => entry.source === source);
      if (asset === undefined) return null;
      return this.createEntry(asset).texture;
    }
    if (source.startsWith('local:')) {
      void this.hydrate(source);
      return null;
    }
    return null;
  }

  /** Keep a video frame on the song clock; pause when the transport pauses. */
  sync(source: string, timeSec: number, playing: boolean): void {
    const video = this.entries.get(source)?.video;
    if (video === null || video === undefined) return;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    const target = duration === null ? timeSec : ((timeSec % duration) + duration) % duration;
    if (!playing) {
      if (!video.paused) video.pause();
      this.seek(video, target, 0.05);
      return;
    }
    if (video.paused) {
      this.seek(video, target, 0);
      void video.play().catch(() => undefined);
      return;
    }
    // The video advances on its own; correct drift rather than seeking every
    // frame, which would stall decoding.
    this.seek(video, target, 0.25);
  }

  /** Import user files into the persistent library and return look refs. */
  async importFiles(files: Iterable<File>): Promise<LedMediaRef[]> {
    const refs: LedMediaRef[] = [];
    for (const file of files) {
      const kind: LedMediaKind | null = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : null;
      if (kind === null) continue;
      const id = crypto.randomUUID();
      await saveAsset(id, file);
      const asset: LedMediaAsset = {
        source: `local:${id}`,
        label: file.name,
        kind,
        url: URL.createObjectURL(file),
      };
      this.localAssets.set(asset.source, asset);
      this.createEntry(asset);
      refs.push(mediaRef(asset));
    }
    if (refs.length > 0) this.notify();
    return refs;
  }

  /** Uploaded assets available on this machine, for the media picker. */
  async listLocalAssets(): Promise<LedMediaAsset[]> {
    // Always merge, so assets imported in an earlier session appear even after
    // this session has added one of its own.
    const records = await listAssets();
    for (const record of records) {
      const source = `local:${record.id}`;
      if (this.localAssets.has(source)) continue;
      this.localAssets.set(source, {
        source,
        label: record.name,
        kind: record.type.startsWith('image/') ? 'image' : 'video',
        url: URL.createObjectURL(record.blob),
      });
    }
    return [...this.localAssets.values()].sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { numeric: true }));
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.video?.pause();
      entry.video?.removeAttribute('src');
      entry.video?.load();
      entry.texture.dispose();
    }
    this.entries.clear();
    for (const asset of this.localAssets.values()) URL.revokeObjectURL(asset.url);
    this.localAssets.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async hydrate(source: string): Promise<void> {
    if (this.hydrating.has(source) || this.entries.has(source)) return;
    this.hydrating.add(source);
    try {
      const id = source.slice('local:'.length);
      const record = await loadAsset(id);
      if (record === null) return;
      const existing = this.localAssets.get(source);
      const asset: LedMediaAsset = existing ?? {
        source,
        label: record.name,
        kind: record.type.startsWith('image/') ? 'image' : 'video',
        url: URL.createObjectURL(record.blob),
      };
      if (existing === undefined) this.localAssets.set(source, asset);
      this.createEntry(asset);
      this.notify();
    } catch (error) {
      console.warn(`could not restore media ${source}`, error);
    } finally {
      this.hydrating.delete(source);
    }
  }

  private createEntry(asset: LedMediaAsset): MediaEntry {
    const entry = asset.kind === 'video' ? this.videoEntry(asset) : this.imageEntry(asset);
    this.entries.set(asset.source, entry);
    return entry;
  }

  private videoEntry(asset: LedMediaAsset): MediaEntry {
    const video = document.createElement('video');
    video.src = asset.url;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const entry: MediaEntry = { asset, texture, video, ready: false };
    video.addEventListener('seeked', () => {
      texture.needsUpdate = true;
    });
    video.addEventListener('loadeddata', () => {
      texture.needsUpdate = true;
      if (!entry.ready) {
        entry.ready = true;
        this.notify();
      }
    });
    video.addEventListener('error', () => {
      console.warn(`could not load wall video ${asset.label}`);
    });
    return entry;
  }

  private imageEntry(asset: LedMediaAsset): MediaEntry {
    const image = new Image();
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    const entry: MediaEntry = { asset, texture, video: null, ready: false };
    image.addEventListener('load', () => {
      texture.needsUpdate = true;
      if (!entry.ready) {
        entry.ready = true;
        this.notify();
      }
    });
    image.addEventListener('error', () => {
      console.warn(`could not load wall image ${asset.label}`);
    });
    image.src = asset.url;
    return entry;
  }

  private seek(video: HTMLVideoElement, target: number, tolerance: number): void {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (Math.abs(video.currentTime - target) > tolerance) video.currentTime = target;
  }
}
