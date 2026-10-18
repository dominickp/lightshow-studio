# dmx-sim (working title)

A browser-based stage-lighting simulator: design lighting effects in time to music, the way a nightclub or DJ rig runs through DMX-controlled fixtures. Built for people who don't have access to real hardware.

- **Plan**: [docs/agent_docs/roadmap.md](./docs/agent_docs/roadmap.md)
- **Decisions (ADRs)**: [docs/agent_docs/decisions.md](./docs/agent_docs/decisions.md)
- **Architecture / repo layout**: [docs/agent_docs/repo-shape.md](./docs/agent_docs/repo-shape.md)
- **Risks**: [docs/agent_docs/risks.md](./docs/agent_docs/risks.md)
- **Spike findings**: [docs/agent_docs/spike-notes.md](./docs/agent_docs/spike-notes.md)
- **Original concept**: [docs/user_docs/project_idea.md](./docs/user_docs/project_idea.md)

## Status

Phase 0 — the lighting/perf spike ([apps/lighting-spike](./apps/lighting-spike)) is working and the core show model ([packages/show-model](./packages/show-model)) is tested. The timeline/editor product app is not started yet.

## Development

```sh
npm install
npm run dev        # runs the lighting spike
npm test           # unit tests
npm run typecheck
npm run build
```

Requires a WebGPU-capable browser (the renderer falls back to WebGL2 when unavailable).
