/** Loop clock. Swapped for the AudioContext clock once audio lands. */
export class LoopClock {
    loopSec;
    playing = true;
    anchorPerf = performance.now();
    anchorTime = 0;
    constructor(loopSec) {
        this.loopSec = loopSec;
    }
    get time() {
        if (!this.playing)
            return this.anchorTime;
        const elapsed = (performance.now() - this.anchorPerf) / 1000;
        return (this.anchorTime + elapsed) % this.loopSec;
    }
    toggle() {
        if (this.playing) {
            this.anchorTime = this.time;
            this.playing = false;
        }
        else {
            this.anchorPerf = performance.now();
            this.playing = true;
        }
    }
    seek(timeSec) {
        const wrapped = ((timeSec % this.loopSec) + this.loopSec) % this.loopSec;
        this.anchorTime = wrapped;
        this.anchorPerf = performance.now();
    }
}
//# sourceMappingURL=clock.js.map