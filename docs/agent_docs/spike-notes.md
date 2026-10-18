# Lighting Spike Notes

## Prototype

`apps/lighting-spike` renders a procedural club/stage scene with 32 fixtures (moving heads, washes, strobes, lasers, and PARs), a 16-bar 130 BPM show, a crowd silhouette instanced mesh, TSL beam-cone haze proxies, floor pools, LED wall, one shadow-casting spotlight, bloom, and a lo-fi grade toggle.

The beams are additive cone meshes with animated TSL noise and scene fog. They are a fast visual proxy, **not** true volumetric raymarching. The next graphics spike should compare this against a half-resolution volumetric pass.

## Observed in the current dev environment

- WebGPU backend active in the integrated Chrome browser.
- 32 fixtures shown, 28 active at the sampled loop position.
- At 100% resolution: about **6.9–7.0 ms rAF interval**, reported as ~143–144 fps; display refresh appears to cap the result.
- About **278–316 draw calls** and **21–23k triangles** in the sampled frame with beams, bloom, and shadows enabled. This uses `renderer.info.render.drawCalls`, reset once per app frame.
- Disabling beam cones, bloom, or shadows each reduced the sampled draw call count (to roughly 248, 246, and 231 in one comparison) without changing the refresh-capped interval.
- The interval stayed near 7 ms as toggles changed, so this environment did not expose the actual performance ceiling. These are prototype observations, not a device-support claim or GPU-time measurement.

## Visual finding

The low-poly venue plus saturated moving beams is visually promising. Additive floor pools and broad overlapping beams can wash out the scene; keep beam/pool intensity conservative. Disabling a full-frame strobe flash materially improved readability. Fixture strobes remain localized and are off by default; they can be enabled for brief downbeat hits. Add a photosensitivity warning before strobe-heavy shows are a normal default.

## Audio clock prototype

`apps/lighting-spike/src/audio-clock.ts` replaces the placeholder performance clock. Song time is `AudioContext.currentTime - outputLatency`, anchored on an `AudioBufferSourceNode`, so play, pause, scrub and loop are all re-anchors rather than a second time source (ADR-002).

- Latency compensation uses `outputLatency` (40 ms in the integrated Chrome here), so visuals follow the sample that is actually audible.
- Looping uses the source node's `loopStart`/`loopEnd`, which is sample-accurate; the visual clock wraps on the same region.
- Choreography is evaluated against the loop's bar grid even when audio looping is off, so the lights never stop or fall out of phase with the beat.
- The transport strip draws waveform peaks (min/max per pixel, computed once after decode), beat and bar ticks, the loop region, and a playhead.

### Measured track facts

`The Koto Chill` (zircon) was analysed offline with a spectral-flux onset envelope plus a dynamic-programming beat tracker:

- **130.00 BPM**, first beat at **0.02 s**; the tempo is stable across the whole file.
- Tempo grid search over the onset envelope is sharp at 130.00, so a constant grid is safe for this track.
- Bars 41–56 (73.87–103.40 s) are a high-energy 16-bar window used as the default loop.
- This is a placeholder for import-time analysis. Auto-detection must stay user-correctable (tap tempo, BPM, offset), which the spike does not implement yet.

### Verified in this environment

- Play/pause/scrub/loop all move the HUD song position and the playhead correctly; seeking to ~101.5 s loops back into 73.87 s as expected.
- No measurable frame-rate change from the transport: still ~6.9 ms rAF interval and ~296 draw calls at 100% resolution.

## Next experiments

1. Compare mesh-cone proxies with a half-resolution volumetric pass and measure both on a 60 Hz / mid-range GPU device.
2. Increase the stress test to 48–64 fixtures; test with bloom and shadows independently.
3. Validate WebGL2 fallback and compare output/quality.
4. Improve physical fixture geometry and DMX profile/channel fidelity before carrying spike code into `packages/renderer`.
5. Add a photosensitivity warning/control before making strobe-heavy shows a normal default.
6. Replace the hard-coded beat grid with real import-time analysis (BPM/offset detection, correctable) and move the transport strip toward the Phase 1 timeline.
