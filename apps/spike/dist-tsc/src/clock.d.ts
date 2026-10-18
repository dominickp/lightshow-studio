/** Loop clock. Swapped for the AudioContext clock once audio lands. */
export declare class LoopClock {
    private readonly loopSec;
    playing: boolean;
    private anchorPerf;
    private anchorTime;
    constructor(loopSec: number);
    get time(): number;
    toggle(): void;
    seek(timeSec: number): void;
}
//# sourceMappingURL=clock.d.ts.map