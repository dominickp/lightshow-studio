import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_MEDIA, LedMediaLibrary } from './media';

/** Long enough to fold several song times into, without wrapping. */
const DURATION_SEC = 4;

/**
 * The subset of `HTMLVideoElement` the library uses. Node has no DOM, so the
 * tests stub `document.createElement` with this and drive the events by hand.
 */
class FakeVideo extends EventTarget {
  src = '';
  loop = false;
  muted = false;
  playsInline = false;
  preload = '';
  duration = DURATION_SEC;
  readyState = 1;
  paused = true;
  /** Every assignment to `currentTime`, which is how a seek shows up. */
  seeks: number[] = [];
  private time = 0;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value;
    this.seeks.push(value);
    this.dispatchEvent(new Event('seeked'));
  }

  play(): Promise<void> {
    // Stays paused and never settles: the "play() is still pending" case.
    return new Promise<void>(() => undefined);
  }

  pause(): void {
    this.paused = true;
  }

  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

const videos: FakeVideo[] = [];

beforeEach(() => {
  videos.length = 0;
  vi.stubGlobal('document', {
    createElement: () => {
      const video = new FakeVideo();
      videos.push(video);
      return video;
    },
  });
});

/** A library with one bundled clip resolved, and the video element behind it. */
function libraryWithClip(): { library: LedMediaLibrary; video: FakeVideo; source: string } {
  const asset = BUNDLED_MEDIA[0];
  if (asset === undefined) throw new Error('no bundled media to test with');
  const library = new LedMediaLibrary();
  library.texture(asset.source);
  const video = videos[0];
  if (video === undefined) throw new Error('no video element was created');
  return { library, video, source: asset.source };
}

describe('LedMediaLibrary warm-up', () => {
  it('seeks a clip to the frame its cue will start on, before it is shown', () => {
    const { library, video, source } = libraryWithClip();

    library.prefetch(source, 6);

    expect(video.currentTime).toBe(2);
    expect(video.paused).toBe(true);
  });

  it('does not re-seek a warmed clip on every pass', () => {
    const { library, video, source } = libraryWithClip();

    library.prefetch(source, 6);
    library.prefetch(source, 6.2);
    library.prefetch(source, 6.5);

    expect(video.seeks).toEqual([2]);
  });

  it('re-arms the warm-up when the cue moves, e.g. after a scrub', () => {
    const { library, video, source } = libraryWithClip();

    library.prefetch(source, 6);
    library.prefetch(source, 40);

    expect(video.seeks).toHaveLength(2);
  });

  it('waits for metadata before trying to seek', () => {
    const { library, video, source } = libraryWithClip();
    video.readyState = 0;

    library.prefetch(source, 6);
    expect(video.seeks).toEqual([]);

    // The element becomes ready and the pending warm-up is applied then.
    video.readyState = 1;
    video.emit('loadedmetadata');
    expect(video.seeks).toEqual([2]);
  });
});

describe('LedMediaLibrary playback alignment', () => {
  it('seeks once when a cue starts, not on every frame', () => {
    const { library, video, source } = libraryWithClip();

    library.sync(source, 1, true);
    library.sync(source, 1.01, true);
    library.sync(source, 1.02, true);

    // A pending play() must not restart the decoder every frame.
    expect(video.seeks).toEqual([1]);
  });

  it('corrects drift gently once the clip is running', () => {
    const { library, video, source } = libraryWithClip();
    video.paused = false;

    library.sync(source, 1, true);
    expect(video.seeks).toEqual([1]);

    // A small drift is left alone; a large one is corrected.
    library.sync(source, 1.1, true);
    expect(video.seeks).toEqual([1]);

    library.sync(source, 3, true);
    expect(video.seeks).toEqual([1, 3]);
  });

  it('pauses clips no wall is showing, so they stop competing for decode', () => {
    const { library, video } = libraryWithClip();
    video.paused = false;

    library.idleExcept(new Set());

    expect(video.paused).toBe(true);
  });

  it('leaves a clip that is on screen running', () => {
    const { library, video, source } = libraryWithClip();
    video.paused = false;

    library.idleExcept(new Set([source]));

    expect(video.paused).toBe(false);
  });
});
