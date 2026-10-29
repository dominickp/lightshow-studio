import { describe, expect, it } from 'vitest';
import { defaultLedLook, ledSurfaceFromFeature } from '@dmxsim/show-model';
import type { LedLookState } from '@dmxsim/show-model';
import { LedWall, type LedMediaRuntime } from './led-wall';

interface SpyRuntime extends LedMediaRuntime {
  asked: string[];
}

/**
 * Records the sources the wall asked for: a texture request is the visible sign
 * that the wall built (or rebuilt) a media material.
 */
function spyRuntime(): SpyRuntime {
  const asked: string[] = [];
  return {
    asked,
    texture: (source: string) => {
      asked.push(source);
      return null;
    },
    sync: () => undefined,
  };
}

function makeWall(runtime: LedMediaRuntime): LedWall {
  return new LedWall(
    ledSurfaceFromFeature({ width: 13.5, height: 6.2, y: 4.9, z: -11.85 }),
    runtime,
  );
}

function mediaLook(source: string): LedLookState {
  return {
    ...defaultLedLook('media'),
    media: { source, kind: 'video', fit: 'cover', label: 'loop' },
  };
}

const show = (target: LedWall, look: LedLookState): void => {
  target.update([{ look, opacity: 1 }], 0, null, 0, false);
};

/** Both additive layers are warmed, so each source is requested twice. */
const distinctSources = (runtime: SpyRuntime): string[] => [...new Set(runtime.asked)];

describe('LED wall media warm-up', () => {
  it('resolves an upcoming clip before its cue, so nothing is loaded late', () => {
    const runtime = spyRuntime();

    makeWall(runtime).prewarm([mediaLook('bundled:007')]);

    expect(distinctSources(runtime)).toEqual(['bundled:007']);
  });

  it('caches the warmed material instead of rebuilding it on every pass', () => {
    const runtime = spyRuntime();
    const target = makeWall(runtime);
    const look = mediaLook('bundled:007');

    target.prewarm([look]);
    const afterFirstPass = runtime.asked.length;
    target.prewarm([look]);

    expect(runtime.asked.length).toBe(afterFirstPass);
  });

  it('ignores generator looks, which have no texture to warm', () => {
    const runtime = spyRuntime();

    makeWall(runtime).prewarm([defaultLedLook('gradient')]);

    expect(runtime.asked).toEqual([]);
  });

  it('rebuilds a media look once its texture lands', () => {
    const runtime = spyRuntime();
    const target = makeWall(runtime);
    const look = mediaLook('local:abc');

    show(target, look);
    // The texture arrived, so the material built over a null texture is stale.
    target.refreshMedia();
    show(target, look);

    expect(runtime.asked).toEqual(['local:abc', 'local:abc']);
  });

  it('invalidates media materials without disturbing the look on screen', () => {
    const runtime = spyRuntime();
    const target = makeWall(runtime);
    const media = mediaLook('bundled:001');
    const generator = defaultLedLook('wave');

    show(target, generator);
    const askedForGenerator = runtime.asked.length;
    target.refreshMedia();
    show(target, generator);

    // A generator look has no texture to wait for, so it is never rebuilt.
    expect(runtime.asked.length).toBe(askedForGenerator);

    target.prewarm([media]);
    const warmed = runtime.asked.length;
    target.refreshMedia();
    target.prewarm([media]);

    expect(runtime.asked.length).toBe(warmed * 2);
  });
});
