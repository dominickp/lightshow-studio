/** Loop clock. Swapped for the AudioContext clock once audio lands. */
export class LoopClock {
  playing = true;
  private anchorPerf = performance.now();
  private anchorTime = 0;

  constructor(private readonly loopSec: number) {}

  get time(): number {
    if (!this.playing) return this.anchorTime;
    const elapsed = (performance.now() - this.anchorPerf) / 1000;
    return (this.anchorTime + elapsed) % this.loopSec;
  }

  toggle(): void {
    if (this.playing) {
      this.anchorTime = this.time;
      this.playing = false;
    } else {
      this.anchorPerf = performance.now();
      this.playing = true;
    }
  }

  seek(timeSec: number): void {
    const wrapped = ((timeSec % this.loopSec) + this.loopSec) % this.loopSec;
    this.anchorTime = wrapped;
    this.anchorPerf = performance.now();
  }
}
