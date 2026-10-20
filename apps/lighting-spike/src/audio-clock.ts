/**
 * Song time from the Web Audio clock.
 *
 * ADR-002: time is never accumulated from frame deltas. Audio plays on an
 * `AudioBufferSourceNode`; the visual position is the context clock minus the
 * output latency, so the frame we draw matches the sample leaving the speakers.
 * Scrubbing and looping are just re-anchoring, never a second time source.
 */

import { clamp } from './lib/math';

interface LoopRegion {
  startSec: number;
  endSec: number;
}

export interface EffectPlaybackPlan {
  /** True when the clip outlasts the sample, so the sample must repeat. */
  loop: boolean;
  /** Wall-clock seconds to play, or `null` for one full sample. */
  stopAfterSec: number | null;
}

/**
 * How a one-shot sample should fit inside a clip.
 *
 * The effect exists only while its clip does: a long clip repeats the sample,
 * a short clip cuts it at the clip boundary. Kept pure so the timing rule is
 * testable without a Web Audio context.
 */
export function effectPlaybackPlan(
  sampleDurationSec: number,
  clipDurationSec: number | undefined,
): EffectPlaybackPlan {
  if (clipDurationSec === undefined) return { loop: false, stopAfterSec: null };
  const clip = Math.max(0, clipDurationSec);
  return {
    loop: clip > sampleDurationSec + 1e-3,
    stopAfterSec: clip,
  };
}

export class AudioClock {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly effectSources = new Set<AudioBufferSourceNode>();
  private isPlaying = false;
  private anchorContextSec = 0;
  private anchorSongSec = 0;
  private loopRegion: LoopRegion | null = null;
  private loopIsEnabled = true;

  constructor() {
    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get ready(): boolean {
    return this.buffer !== null;
  }

  get loopEnabled(): boolean {
    return this.loopIsEnabled;
  }

  /** Seconds between the scheduled sample and the sample the user hears. */
  get latencySec(): number {
    return this.context.outputLatency || this.context.baseLatency || 0;
  }

  get time(): number {
    if (!this.isPlaying) return this.anchorSongSec;

    const elapsed = Math.max(0, this.context.currentTime - this.anchorContextSec - this.latencySec);
    const raw = this.anchorSongSec + elapsed;
    const loop = this.loopIsEnabled ? this.loopRegion : null;
    if (loop === null) return Math.min(raw, this.duration);

    const length = loop.endSec - loop.startSec;
    if (length <= 0 || raw < loop.endSec) return raw;
    return loop.startSec + ((raw - loop.startSec) % length);
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.context.decodeAudioData(data);
  }

  load(buffer: AudioBuffer): void {
    this.pause();
    this.stopSource();
    this.stopEffects();
    this.buffer = buffer;
    this.anchorSongSec = this.loopIsEnabled && this.loopRegion !== null ? this.loopRegion.startSec : 0;
  }

  /** Ramp rather than jump, so level changes do not click. */
  setVolume(value: number): void {
    const target = clamp(value, 0, 1);
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setTargetAtTime(target, now, 0.015);
  }

  /**
   * Fire a one-shot sample through the master playback gain, so the effect
   * follows the transport volume and mute. Used for performance cues such as
   * cryo jets that have their own sound but no song-time buffer.
   *
   * Passing `clipDurationSec` fits the sample to the cue: it repeats when the
   * clip is longer than the sample and is cut off when the clip is shorter.
   */
  playOneShot(buffer: AudioBuffer, gain = 1, rate = 1, clipDurationSec?: number): void {
    const plan = effectPlaybackPlan(buffer.duration / Math.max(0.25, rate), clipDurationSec);
    if (plan.stopAfterSec !== null && plan.stopAfterSec <= 0.01) return;

    if (this.context.state !== 'running') void this.context.resume();
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.25, Math.min(4, rate));
    source.loop = plan.loop;
    const level = this.context.createGain();
    level.gain.value = clamp(gain, 0, 2);
    source.connect(level).connect(this.gain);
    this.effectSources.add(source);
    source.onended = () => {
      this.effectSources.delete(source);
      source.disconnect();
      level.disconnect();
    };
    source.start();
    if (plan.stopAfterSec !== null) {
      source.stop(this.context.currentTime + plan.stopAfterSec);
    }
  }

  /** Cue sounds are part of playback, so pause/seek/load must silence them. */
  private stopEffects(): void {
    for (const source of this.effectSources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
    this.effectSources.clear();
  }

  setLoop(region: LoopRegion, enabled = this.loopIsEnabled): void {
    const now = this.time;
    this.loopRegion = region;
    this.loopIsEnabled = enabled;
    this.reanchor(now);
  }

  setLoopEnabled(enabled: boolean): void {
    if (this.loopIsEnabled === enabled) return;
    const now = this.time;
    this.loopIsEnabled = enabled;
    this.reanchor(now);
  }

  async play(): Promise<void> {
    if (this.buffer === null || this.isPlaying) return;
    if (this.context.state !== 'running') await this.context.resume();
    this.isPlaying = this.startSource(this.anchorSongSec);
  }

  pause(): void {
    if (!this.isPlaying) return;
    const now = this.time;
    this.isPlaying = false;
    this.anchorSongSec = now;
    this.stopSource();
    this.stopEffects();
  }

  async toggle(): Promise<void> {
    if (this.isPlaying) this.pause();
    else await this.play();
  }

  seek(songSec: number): void {
    if (this.buffer === null) return;
    this.stopEffects();
    const target = this.normalizePosition(songSec);
    if (this.isPlaying) this.isPlaying = this.startSource(target);
    else this.anchorSongSec = target;
  }

  private reanchor(songSec: number): void {
    if (this.isPlaying) {
      this.isPlaying = this.startSource(songSec);
      return;
    }
    this.anchorSongSec = this.normalizePosition(songSec);
  }

  /**
   * A loop is a brace, not a cage: positions before the loop start are valid
   * (intro/verse auditioning) and play through into the loop. Only positions at
   * or past the loop end are folded back inside it.
   */
  private normalizePosition(songSec: number): number {
    const clamped = clamp(songSec, 0, this.duration);
    const loop = this.loopIsEnabled ? this.loopRegion : null;
    if (loop === null) return clamped;
    const length = loop.endSec - loop.startSec;
    if (length <= 0) return clamp(loop.startSec, 0, this.duration);
    if (clamped < loop.endSec) return clamped;
    return loop.startSec + ((clamped - loop.startSec) % length);
  }

  private startSource(songSec: number): boolean {
    const buffer = this.buffer;
    if (buffer === null) return false;

    this.stopSource();

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const loop = this.loopIsEnabled ? this.loopRegion : null;
    let offset: number;
    if (loop !== null && loop.endSec > loop.startSec) {
      source.loop = true;
      source.loopStart = loop.startSec;
      source.loopEnd = loop.endSec;
      // Starting before the loop is legitimate; the source plays the intro and
      // then wraps at loopEnd. Starting past it is folded into the loop.
      offset = clamp(songSec, 0, Math.max(0, buffer.duration - 0.002));
    } else {
      offset = clamp(songSec, 0, Math.max(0, buffer.duration - 0.002));
    }

    // Anchors move before `start`, so a rejected start still leaves the clock
    // reporting the position the user asked for instead of jumping.
    this.anchorContextSec = this.context.currentTime;
    this.anchorSongSec = offset;

    try {
      source.start(0, offset);
    } catch (error) {
      console.error('AudioClock: could not start playback', error);
      source.disconnect();
      return false;
    }

    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.isPlaying = false;
      this.anchorSongSec = buffer.duration;
    };
    this.source = source;
    return true;
  }

  private stopSource(): void {
    if (this.source === null) return;
    this.source.onended = null;
    try {
      this.source.stop();
    } catch {
      // Already stopped; stop() throws when the node never started.
    }
    this.source.disconnect();
    this.source = null;
  }
}
