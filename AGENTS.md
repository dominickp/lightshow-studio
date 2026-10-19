## User docs
`./docs/user_docs` is where the user places their docs. Never modify these.

## Agent docs
`./docs/agent_docs` is where agents may document things. Do not use this as a messy dumping ground.

## Testing hook (lighting spike)
`window.__dmxsim` in `apps/lighting-spike` drives playback programmatically via Playwright: `seek(sec)`, `play()`, `pause()`, `toggle()`, plus `time`, `playing`, `duration` (null until audio loads) and `fixtureCount`. Use it to scrub the playhead instead of clicking the ruler.
