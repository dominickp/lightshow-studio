# Lightshow Studio

A browser-based stage-lighting simulator: design lighting effects in time to music, the way a nightclub or DJ rig runs through DMX-controlled fixtures. I made this because I like stage lighting effects but I don't have access to real hardware.


## Features

## Venue customization
- Add/remove lights
- Move lights around different parts of the stage
- Lights can have the direction, beam angle, and other settings adjusted

### Lights supported
- Moving heads
- Par/wash
- Strobes
    - 
- LED walls
    - Supports simple generated patterns, pre-generated video loops, or custom images/videos uploaded into the app
- Lasers
    - Control tilt/pan direction, with a couple different array shapes
- Cryo-jets


## Coming soon
- Fire effects
- Gobos


## Use of AI
This codebase is completely written with AI, using OpenRouter via VSCode Copilot. It was mainly Deepseek 4.1 Flash 1017 but glm-5.3-flash also contributed a few bugs along the way. 

## Development

```sh
npm install
npm run dev        # runs the studio app
npm test           # unit tests
npm run typecheck
npm run build
```

Requires a WebGPU-capable browser (the renderer falls back to WebGL2 when unavailable).
