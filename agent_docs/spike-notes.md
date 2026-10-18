# Lighting Spike Notes

## Prototype

`apps/spike` renders a procedural club/stage scene with 32 fixtures (moving heads, washes, strobes, lasers, and PARs), a 16-bar 128 BPM show, a crowd silhouette instanced mesh, TSL beam-cone haze proxies, floor pools, LED wall, one shadow-casting spotlight, bloom, and a lo-fi grade toggle.

The beams are additive cone meshes with animated TSL noise and scene fog. They are a fast visual proxy, **not** true volumetric raymarching. The next graphics spike should compare this against a half-resolution volumetric pass.

## Observed in the current dev environment

- WebGPU backend active in the integrated Chrome browser.
- 32 fixtures shown, 28 active at the sampled loop position.
- At 100% resolution: about **6.9–7.0 ms rAF interval**, reported as ~143–144 fps; display refresh appears to cap the result.
- About **316 draw calls** and **23k triangles** in the sampled frame with beams, bloom, and shadows enabled.
- Disabling beams reduced the sampled draw calls to about 248; disabling bloom reduced it to about 246; disabling shadows reduced it further to about 231.
- The interval stayed near 7 ms as toggles changed, so this environment did not expose the actual performance ceiling. These are prototype observations, not a device-support claim or GPU-time measurement.

## Visual finding

The low-poly venue plus saturated moving beams is visually promising. Additive floor pools and broad overlapping beams can wash out the scene; keep beam/pool intensity conservative. Disabling a full-frame strobe flash materially improved readability. Fixture strobes remain localized and are off by default; they can be enabled for brief downbeat hits. Add a photosensitivity warning before strobe-heavy shows are a normal default.

## Next experiments

1. Compare mesh-cone proxies with a half-resolution volumetric pass and measure both on a 60 Hz / mid-range GPU device.
2. Increase the stress test to 48–64 fixtures; test with bloom and shadows independently.
3. Validate WebGL2 fallback and compare output/quality.
4. Improve physical fixture geometry and DMX profile/channel fidelity before carrying spike code into `packages/renderer`.
5. Add a photosensitivity warning/control before making strobe-heavy shows a normal default.
