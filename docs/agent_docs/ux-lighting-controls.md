# Lighting Show-Authoring UI: UX and Information Architecture

This document evaluates the show-authoring surface of the DMX simulator: the lower dock that currently combines a transport, waveform, ruler, and one lane per fixture. It defines what the component should be called, what a lighting programmer expects to do in it, which controls each fixture type needs, how the arrangement should behave, and the gap between the current spike and a credible first authoring pass. It is intentionally opinionated and scoped to the existing show model (`Clip` envelopes over `ControllableAttribute`) rather than a generic DAW or console clone.

## What this component is called

The dock is not a "timeline" widget and not a "cue list". It is a **multi-track time-based show editor**: a horizontal time axis plus vertically stacked fixture lanes containing time-ranged clips. The current code mixes three vocabularies: `Arrangement` (class and dock label), `Cue` (data model and UI ids such as `cue-action`, `cue-status`), and `Clip` (the type it finally emits via `toClip`). That inconsistency is the first thing to fix.

### Taxonomy

| Term | Meaning | Scope |
|---|---|---|
| **Timeline** | The time axis itself: ruler, playhead, scrubbing, loop region. Also a video-editing view. | Axis, not the whole editor |
| **Arrangement** | The whole linear, multi-track editing surface and the document section it edits. | Whole component |
| **Playlist** | FL Studio's name for its arrangement; also a generic ordered list. Not standard in current lighting consoles. | DAW-specific |
| **Track** | A vertical row assigned to a fixture, group, or bus. | Row |
| **Lane** | The editable time area *inside* a track where clips live. | Row content |
| **Clip** | A time-ranged object carrying envelopes; the project's only authoring primitive (ADR-005). | Authoring unit |
| **Cue** | A single stored lighting look/state, traditionally fired by Go. Implies discrete states, not envelopes. | Console unit |
| **Cue list** | An ordered list of cues with per-cue timing and links. Eos and Avolites term. | Console structure |
| **Cue stack** | ChamSys's name for a cue list; Avolites treats "stack" as a synonym. | Console structure |
| **Sequence** | grandMA3's cue container, shown in a Sequence Sheet with optional value-tracking columns. | Console structure |

### Vendor vocabulary

- **FL Studio — Playlist.** The Playlist sequences "Clip Tracks" containing pattern, audio, and automation clips; tracks are not bound 1:1 to instruments by default. Clips are placed on a time grid and executed when the playhead reaches them ([FL Studio manual](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm)).
- **Ableton Live — Arrangement View.** The Arrangement is the linear song layout; tracks stack vertically with a "main lane" for clips, a beat-time ruler, scrub area, locators, and automation lanes ([Ableton manual](https://www.ableton.com/en/live-manual/12/arrangement-view/)).
- **Logic Pro / Cubase / NLEs.** Logic calls the editable song surface the **Tracks area** (regions on tracks); Cubase uses the **Project window** (track list plus event display); Premiere/Resolve call the horizontal editor the **Timeline** with video/audio tracks and clips. These confirm the general model: arrangement surface → tracks → clips/regions.
- **grandMA3 — Sequence, Sequence Sheet, timeline events.** Cues live in **Sequences**; a Sequence Sheet shows cue rows, timing columns, and an optional value-tracking section. Timecode playback is a separate event/timeline layer, not the cue editor itself ([MA cue sequences](https://help.malighting.com/grandMA3/2.2/HTML/cue_sequence.html), [Sequence Sheet](https://help.malighting.com/grandMA3/2.2/HTML/cue_sequence_sheet.html)).
- **ETC Eos — Cue List and Blind.** Cues are edited in a **Cue List**; **Blind** edits cues without affecting live output. This is the canonical theatre workflow ([Eos Family manual](https://www.etcconnect.com/WebDocs/Controls/EosFamilyOnlineHelp/en/Content/01_Welcome/WELCOME_TO_EOS.htm)).
- **ChamSys MagicQ — Cue Stack.** Cue Stacks hold cues with stack-level defaults and options; macros can drive other stacks ([MagicQ docs](https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/cue_stack_settings.html)).
- **Hog 4 — Cues and Cuelists.** Hog uses **Cuelists**, not "Playlists". The v3.15 manual's "Cues and Cuelists" chapter covers tracking, cue-only recording, blocking, and timing ([Hog cuelists](https://www.etcconnect.com/webdocs/Controls/HOG/HTML/en/sect-cuelists_intro.htm), [Hog tracking](https://www.etcconnect.com/webdocs/Controls/HOG/HTML/en/sect-ww_tracking.htm)). The brief's "Hog (Playlist)" should be corrected.
- **Avolites Titan — Cue List, Chase, Timeline.** Avolites explicitly distinguishes a cue (one look), a chase (timed cue sequence), a cue list (Go-driven sequence), and a **Timeline** (triggers replayed against internal or external timecode). Its manual is the clearest published statement of the distinction ([Avolites cues](https://manual.avolites.com/docs/cues), [Timelines](https://manual.avolites.com/docs/timelines)).

### Recommendation

Call the component the **Arrangement**; call the rows **fixture lanes**; call the blocks **clips**. Label the dock "Arrangement" and the inspector "Clip inspector". Rename `Cue`/`CueAction` internally to `Clip`/`ClipAction` in the next pass, and remove "cue" from user-visible strings (`#cue-action`, `#cue-status`, "clip action"). Keep "timeline" for the ruler/axis and "loop region" for the loop. "Cue" should only return if a separate step-sequencing/cue-list mode is added; using it for envelope clips will mislead anyone coming from a console.

## User goals by fixture type

All controls must be gated by `profile.capabilities` and must map only to attributes the model can animate: `dimmer`, `red`, `green`, `blue`, `white`, `pan`, `tilt`, `zoom`, `focus`, `strobe`, `rotation`. `gobo` and `prism` exist as channel/capability entries but are **not** in `ControllableAttribute`, so they cannot be authored as clip envelopes today.

| Fixture type | What the user wants | Controls needed | 2D / gesture notes |
|---|---|---|---|
| **Moving head / spot** | Aim the beam, then give it musical movement and a look | Dimmer + fade; RGBW colour; pan/tilt; zoom (beam angle); focus; strobe; rotation; gobo/prism (static until model supports them); movement shape | **2D pan/tilt pad** with crosshair, fixture-limit bounds, and a "bounce/circle/figure-8/sweep" shape selector with size, speed, direction (CW/CCW), and phase offset. Do not ship two bare sliders. Drag on the pad should set a target; shift-drag should draw a movement path. |
| **Wash** | Fill the stage/floor with smooth colour and a controllable pool size | Dimmer + fade; RGB or RGBW colour; zoom; strobe; pan/tilt if present | Same 2D pad as a moving head but emphasise a large zoom range and colour-first workflow. "Softness" has no model attribute; express it through zoom/beam spread and renderer falloff, not a fake slider. |
| **Strobe / blinder** | Hit accents, not just "on" | Dimmer; colour/white where available; strobe rate; shutter/open duration; fade/attack | No pan/tilt. Use a **rate control with Hz and note-division units** (1/4, 1/8, 1/16), a duration/shutter width control, and a one-shot "hit" preset. Blinder should default to warm white and a short attack. |
| **LED strip / pixel** | Chases, segments, and directional movement | Dimmer; RGBW colour; strobe; segment count, chase direction, chase speed, pattern | No per-segment model exists: `LED_STRIP` is one fixture with a single RGBW state. Offer whole-strip colour/chase presets now; add a sub-fixture/cell model later. Direction should be a segmented arrow control, not a number. |
| **Laser** | Aim, rotate patterns, and control intensity/safety | Dimmer; RGB colour; pan/tilt (small range); rotation; pattern selection; pattern speed; safety/master | Use a 2D aim pad plus a pattern/rotation dial. Safety is show-level, not per-clip: a persistent laser-enable/blackout control and a warning state. Pattern and speed are model gaps; map rotation now and add pattern later. |
| **PAR** | Simple colour and level | Dimmer + fade; RGBW; zoom if present | No pad. A colour swatch grid plus level is enough; avoid exposing irrelevant movement controls. |

## Authoring workflow

A lighting programmer generally works in this order:

1. **Patch and rig** — fixtures, addresses, groups, positions.
2. **Build palettes/presets** — reusable positions, colours, gobos/beams. Avolites stores palette *references* in cues, so changing a palette updates every cue that uses it ([Avolites palettes](https://manual.avolites.com/docs/palettes)).
3. **Choose a control model** — cue list for repeatable theatre/Go operation, or timecode/timeline for a fixed song. Avolites recommends Timeline when a recorded track or timecode drives the show; MA3 and Hog similarly separate cue sequencing from timecode.
4. **Record looks** — cue-by-cue, or live-record triggers onto a timeline. Tracking carries unchanged values forward; **cue-only** prevents an inserted cue from leaking into later cues ([Hog tracking](https://www.etcconnect.com/webdocs/Controls/HOG/HTML/en/sect-ww_tracking.htm)).
5. **Time it** — fade-in/out, delay-in/out, per-attribute-group times, fixture overlap, follow/hang/wait. Avolites exposes separate Fade In, Delay In, Fade Out, Delay Out, plus per-IPCGBES and per-attribute times ([Avolites cue timing](https://manual.avolites.com/docs/cue-lists/cue-list-timing)).
6. **Add movement/effects** — shape generators, chases, pixel mapping; speed and size are show-time controls, not baked keyframes ([Avolites effects](https://manual.avolites.com/docs/effects)).
7. **Run and correct** — busk with palettes and executors, or run to timecode; keep Blind/undo available for fixes.

This product is a **song-first timecode arranger**, not a theatre cue-list console. The primary flow should be: import audio → confirm BPM/offset → create groups/presets → draw clips on the beat grid → shape envelopes and effects → loop and refine. A cue-list/step mode can be a secondary mode later, but it must not dictate the clip editor's data model.

## Control inventory

### Transport / timeline

- Play/pause, stop, scrub, loop enable, current/total time, bar.beat display.
- Waveform with beat/bar ticks and a loop region; click waveform or ruler to seek.
- Snap selector: **Off / Bar / Beat / 1/8 / 1/16** (default 1/16), with Alt/Cmd held to bypass.
- BPM and first-beat offset fields; tap tempo; "re-analyze" status; grid must remain user-correctable (ADR-003).
- Zoom out/in, zoom slider, **Fit song**, **Fit loop**, zoom percentage.
- Follow-playhead toggle; auto-suspend when the user scrolls away.
- Markers/locators for sections; loop in/out handles.

### Clip editing

- Draw/create in a lane; move; resize left/right; delete.
- Duplicate, split at playhead, copy/paste at playhead (preserve relative offsets).
- Multi-select (shift-click, marquee, Ctrl/Cmd+A), nudge by snap unit, quantize.
- Clip inspector: preset/action, name, colour, fade in/out, easing, per-attribute envelopes.
- Fade handles on the clip body for dimmer fade-in/out, independent of clip length.
- Lock clip; mute/solo lane; clip overlap/priority indication.
- Context menu with the same operations; keyboard-first equivalents.

### Per-fixture attributes

| Attribute | Control | Notes |
|---|---|---|
| `dimmer` | 0–100% slider + envelope + fade in/out | Primary; also the show-level grand master/blackout. |
| `red`,`green`,`blue`,`white` | Colour picker, swatch grid, RGB/HSV, white channel for RGBW | Stop limiting users to five `CUE_COLORS` entries. |
| `pan`,`tilt` | 2D pad with limits; numeric degrees; shape generator | Show degrees, not 0–1; clamp to `profile.limits`. |
| `zoom` | Slider labelled in degrees (full-angle spread) | Use `profile.beam.spreadDeg`, not a raw percentage. |
| `focus` | Slider; optionally a focus preset | Capability-gated. |
| `strobe` | Hz slider **and** note-division selector; duration/shutter | Both units must display the same resolved value. |
| `rotation` | Dial/angle control; direction; speed | Degrees per second or degrees per beat. |
| `gobo`,`prism` | Read-only capability badges for now | Not animatable; extend `ControllableAttribute` before exposing editors. |

### Show-level

- BPM/offset, master dimmer, blackout, strobe enable/photosensitivity warning, laser enable.
- Fixture groups and palettes/presets library.
- Track visibility/lock/mute, reorder, collapse, height.
- Save/load/autosave, undo/redo, show name, export.
- Camera/view controls and fixture-count/debug HUD stay outside the authoring surface.

## Fixture control layers and behavior

Separate **fixture setup**, **static look controls**, and **time-varying behavior** so the same direction control does not mean different things depending on context:

1. **Placement / mount:** fixture position and mounting orientation in the loaded venue. Fixed fixtures use this yaw/pitch to point; truss or venue attachment points can constrain placement. This belongs to the fixture/venue editor and is saved with the show.
2. **Look / clip values:** dimmer, color, beam angle, focus, strobe, and rotation where supported. Use physical units in the inspector: percent, RGB/white, full beam angle in degrees, focus, Hz or musical rate, and degrees/rate. A clip captures values over a song-time range.
3. **Motion behavior:** pan/tilt fixtures have a static aim target and optional animated movement relative to their mount. The user chooses target/path or a shape (sweep, circle, figure-8, bounce), range, speed in cycles/beat or seconds, direction, and phase. Fixed fixtures have no animated pan/tilt; the user changes their placement aim instead.
4. **Atmosphere:** venue-wide haze is a persistent scene setting; positioned fog machines emit local atmosphere that can be triggered/faded by song-time clips, with density, coverage, and decay. Atmosphere is not a fixture beam and should be independently controllable.

### Prototype now in the lighting spike

The selected fixture's panel is a side panel docked to the right of the arrangement, not a floating overlay. Clicking a fixture's track name opens it for that fixture, clicking the same name again closes it, and the timeline column reclaims the full width while it is closed. Resizing the panel persists. The panel shows the fixture kind, id and model, capability chips, and clip counts (total and under the playhead) alongside the **fixture setup** controls: mount yaw and pitch, level, and beam angle for zoom-capable profiles. Setup is the persisted layer that applies when no clip asserts an attribute. Beam angle is mapped through the profile's spread range. **The current clip vocabulary is coarse** — action (hold/fade/pulse/sweep/strobe) and one of five palette colours. It authors dimmer, RGB, pan/tilt, and strobe envelopes, but never `zoom`, so beam angle is a fixture-only setting today even though the show model supports animating it. The demo sweep remains a hard-coded canned action, not an editable movement-pattern authoring system.

### User-facing control behavior by fixture family

- **Moving head / spot:** mount orientation stays fixed; pan/tilt set the static aim or animate around it. Beam angle/zoom, focus, dimmer, color, strobe, gobo/prism, and rotation appear only when supported by the profile. The first full editor should use a 2D aim pad, with range bounds and an optional movement-pattern editor rather than raw normalized sliders.
- **Wash:** mount/aim and pan/tilt behave like moving heads; beam angle controls coverage. Prefer broad area/color controls; do not invent a separate softness parameter unless the renderer models it.
- **Fixed PAR / blinder / strobe / LED strip:** position and mount angle set direction; no pan/tilt animation unless the physical profile supports it. Expose beam/field angle only if zoom is supported. Strobe controls should distinguish rate from on-time/shutter width; wide LED emitters need shape-aware output rather than a round spotlight proxy.
- **Laser:** mount/aim plus constrained pan/tilt, pattern and rotation controls; retain a show-level safety enable/blackout and warning. Laser patterns require a distinct rendering model; do not treat a laser as an ordinary wide cone.

## Interaction and navigation spec

- **Snapping.** Default 1/16; options Off/Bar/Beat/1/8/1/16. Snap relative to `beatGrid.offsetSec`, never to zero. Snap both clip edges and moves; Alt/Cmd bypasses. Show the snapped bar.beat in a tooltip while dragging.
- **Zoom.** `Ctrl/Cmd+wheel` zooms around the pointer (implemented); plain wheel scrolls vertically and `Shift+wheel` horizontally. `Ctrl/Cmd +` / `-` step zoom, `Ctrl/Cmd+0` fits the song, `F` fits the loop. The current log slider spans 0.25–480 px/s with a Fit button; add a Fit-loop action and a reset-to-100% affordance. Consider showing bar/beat width or "px per beat" alongside the percentage.
- **Sticky chrome.** Transport and clip inspector stay pinned above the scroll area; ruler and waveform are sticky at the top of the scroll area; track labels stick left (implemented). The playhead is drawn across the ruler, waveform, and every lane from one time source.
- **Follow playhead.** Continuous follow with a right-margin buffer (implemented as a two-boundary band); add auto-disable on manual scroll and a "jump back to playhead" affordance.
- **Selection and clipboard.** Shift-click range/individual, marquee in lanes, cross-lane selection. Copy/paste preserves relative time and lane. Duplicate offsets by clip length. Split at playhead across selected clips.
- **Undo.** Every mutation (create/move/resize/delete/action/colour/fade/envelope) goes through a command object; `Ctrl/Cmd+Z` / `Shift+Ctrl/Cmd+Z`. Undo must cover multi-select operations atomically.
- **Tracks.** Reorder by dragging headers; group tracks (fixtures → group lane); collapse to a summary lane; row-height presets (compact/normal/tall). Keep lane order in the show document, not inferred from `show.fixtures`.
- **Keyboard map.** Space play/pause; `S` split; `D` duplicate; `Delete`/`Backspace` delete the selected clip (implemented); `Ctrl/Cmd+C/V` copy/paste; `B` cycle snap; `F` follow; `L` loop; `M` marker; arrows nudge one snap unit; `Shift+arrows` one bar; `Esc` clear selection; `Ctrl/Cmd+0` fit song.
- **Accessibility.** Clips need focusable elements, roving tabindex, and ARIA labels; pointer-only `div` clips are not keyboard-editable. Do not rely on colour alone for action/selection.

## Dimmer and effect semantics

- **Fade times are independent of clip length.** `fadeInSec`/`fadeOutSec` already exist on `Clip` and are applied by `fadeEnvelope`; the UI must expose them and draw handles, not derive them from clip duration. A 4-bar clip can have a 1-beat fade.
- **Fade only multiplies when a dimmer envelope exists.** `resolveAttributes` only computes `fade` when `clip.attributes.dimmer` is present, so a fade on a colour-only or pan-only clip does nothing. Either always apply the envelope to `intensity` or document the constraint; do not silently ignore user input.
- **Dimmer curves.** The model offers clip-level `Easing` (`linear`, `sine`, `easeInOut`, `step`), not a per-fixture dimmer curve. Offer these four as "fade shape" presets; if console-style curves (square law, S-curve) are needed, add a `dimmerCurve` field or bake keyframes. Do not fake a curve control that changes nothing.
- **Attack/release.** For blinders/strobes, attack and release are separate from fade: use short fade-in and longer fade-out defaults, and expose a one-shot decay. `strobe` is currently a steady normalized rate, not a duration; add shutter width/duration before calling it a blinder.
- **Strobe rate.** Store normalized `strobe` but display both **Hz** (map through `profile.limits.strobeHz`) and **musical division** (rate = BPM/60 × hits-per-beat). Locking to 1/8 or 1/16 must be phase-aligned to the beat grid; changing BPM must either re-derive the rate or mark the clip as free-running.
- **Beat-synced effects.** Shape speed should be expressed in cycles/beat, rotation in degrees/beat, and chase speed in steps/beat, then converted to envelopes at evaluation time. This keeps the show musical when BPM changes.
- **Overlap.** Current evaluation iterates clips and lets later clips overwrite earlier values; define HTP/LTP-style precedence (dimmer highest-takes-precedence, other attributes latest-takes-precedence) and show it in the UI before users stack clips.

## Current gaps

Severity reflects user impact on the next authoring pass.

| Gap | Evidence | Severity |
|---|---|---|
| Authoring model is a coarse preset, not an envelope editor | `Cue` in `arrangement.ts` stores only `action` + `colorIndex`; `toClip()` hardcodes dimmer/pan/tilt/strobe keyframes. | **High** |
| Clip inspector only edits action and colour | `syncCueInspector` in `src/main.ts` builds two selects; the fixture side panel edits persisted setup (mount and defaults) but does not author clip values. No clip fade, strobe rate, zoom, focus, pan/tilt target, or white control exists. | **High** |
| No per-clip fade editing; fixed values | `toClip()` sets `fadeInSec` 0/0.04 and `fadeOutSec` 0.08; `evaluate.ts` only applies fade when a dimmer envelope exists. | **High** |
| Strobe is one fixed value, no rate/duration | `toClip()` sets `strobe: [{ at: 0, value: 0.78 }]`; `evaluateFixture` maps it to Hz continuously. | **High** |
| No undo/redo, multi-select, clipboard, split, duplicate | `arrangement.ts` mutates `this.cues` directly in `pointerMove`, `createCue`, `deleteSelected`; `pointerDown` tracks one selection only. | **High** |
| In-memory only; no save/load/autosave | `setTimeline()` clears `this.cues`; loading another audio file in `main.ts` rebuilds the timeline and discards work. | **High** |
| Snap is hardcoded to 1/16 | `Arrangement.snap()` divides the beat by 4; no off/bar/beat options, no Alt bypass. | **High** |
| DOM full re-render on every pointer move | `pointerMove()` calls `renderRows()`, which rebuilds `root.innerHTML`; this will jank with many clips (risks.md already flags canvas). | **High** |
| BPM/offset cannot be edited; imported audio has `bpm: null` | `src/track.ts` constants; `main.ts` sets `bpm: null` on import and `createRuler()` prints "Beat grid not set". | **Medium–High** |
| Loop region is editable but not saved | The ruler grips and Shift+drag update the loop live; `Loop`/`Fit loop` control playback and zoom. There is no save/restore, and the loop is not part of the show document yet. | **Medium** |
| No groups, palettes, or preset library | `renderRows()` maps `show.fixtures` directly; no track grouping or palette model; `CUE_COLORS` is the entire preset vocabulary. | **Medium** |
| No track reorder/collapse/height; headers not editable | `renderRows()` writes fixed rows in fixture order; track header shows `fixture.id` and a capability string only. | **Medium** |
| Clip overlap is undefined | `resolveAttributes()` overwrites values in array order; no priority/HTP/LTP display. | **Medium** |
| Follow-playhead has no auto-suspend on manual scroll | `frame()` in `main.ts` keeps a two-boundary follow band while playing; manually scrolling during playback fights it. | **Low** |
| No playhead seek from lanes | The waveform and ruler now seek; lane backgrounds still only create/move clips (click-drag starts a clip rather than moving the playhead). | **Low** |
| RGBW white channel is unused in authoring | Profiles support `'rgbw'`, `evaluate.ts` adds `white`, but the inspector has no white control. | **Medium** |
| Accessibility and keyboard editing are absent | Clips are pointer-only `div`s; no focus/ARIA; keydown handlers in `main.ts` ignore inputs but do not edit clips. | **Low–Medium** |
| "Cue" and "Clip" vocabulary is mixed | UI ids `cue-action`, `cue-status`, labels "Clip action", class `Cue`, output type `Clip`. | **Low** (high confusion) |

## Phased roadmap

### Now — make the existing arrangement trustworthy (1–2 days)

1. Rename user-facing copy to Arrangement / fixture lane / clip; keep ids temporarily but add a vocabulary pass in code.
2. Add an editable **Clip inspector**: fade in/out, action, colour (including white), dimmer, pan/tilt pad, zoom, focus, strobe rate. Capability-gate every control; never show a dead slider.
3. Replace fixed fade/strobe values in `toClip()` with values from the clip; apply fades to intensity even when only colour is authored.
4. Add a snap selector (Off/Bar/Beat/1/8/1/16, default 1/16) and Alt bypass; snap to `firstBeatSec`.
5. Add undo/redo commands around create/move/resize/delete/action/colour; add multi-select, duplicate, split, copy/paste.
6. Add save/autosave of clips (localStorage or `.dmxsim` JSON) so a reload does not destroy work; restore on timeline load.
7. Persist the loop region in the show document and add keyboard in/out nudging. Loop grips, Shift+drag, Loop toggle, and Fit loop already exist; follow-playhead needs auto-suspend on manual scroll.
8. Fix the full-`innerHTML` rebuild on pointer move by updating only the dragged clip, or move to a canvas clip layer.

### Next — expressive, musical authoring (1–2 weeks)

1. **Envelope lane editor** per attribute (dimmer, pan/tilt, colour, zoom, strobe) with keyframes, segment easing, and copy/paste of envelopes.
2. **Preset/palette library** (positions, colours, beams) and fixture **groups**; clips can reference or expand presets, with a clear "reference vs baked" indicator.
3. **Movement shape generator** for pan/tilt: circle, figure-8, sweep, bounce, with size/speed/direction/phase; generates editable envelopes.
4. **Strobe/blinder controls** with Hz and note-division units, shutter duration, attack/release, and one-shot hits.
5. **BPM/offset editor and tap tempo**; make `createRuler` and snapping react to corrected grids; persist the grid in the show.
6. **Track operations**: reorder, group, collapse, height presets; group-level clips that fan out to member fixtures.
7. Canvas-rendered clips and virtualisation for 16–32 fixtures × hundreds of clips; keyboard navigation and focusable clips.
8. Autosave, schema versioning, and undo persistence.

### Later — vertical slice depth

1. **Cue-list mode** alongside timecode: ordered cues, Go, follow/hang, cue-only/tracking/block, Blind editing. Keep it a separate mode; do not overload clips.
2. **Sub-fixture/cell model** for LED strips: segments, chase direction, pixel patterns, and per-cell envelopes.
3. **Gobo/prism and laser patterns** as first-class controllable attributes, with effect presets and rotation/speed.
4. Group editing with fan/chase offsets; relative values; palettes that update referenced clips.
5. Export video and DMX compile; show file portability; photosensitivity and laser-safety gates.
6. Full keyboard-only workflow, ARIA grid semantics, and screen-reader labels for clips and lanes.

## Open questions

1. Is the primary model **timecode arrangement** or **cue list**? Recommendation: timecode first; add cue-list mode later without changing the clip document model.
2. Should a clip belong to a **fixture**, a **group**, or either? Groups are essential for "all washes" authoring; a group clip needs a fan-out rule.
3. Do palettes/presets **generate** envelopes (baked) or are they **referenced** (live link)? Avolites references; ADR-005 implies generators. Pick one and show it.
4. Is dimmer curve a **clip easing** or a **fixture/profile curve**? The model currently supports only clip `Easing`; do not add a UI control without a document field.
5. Do we add `gobo` and `prism` to `ControllableAttribute` now, or keep them read-only until the renderer supports them? Shipping dead controls is worse than deferring.
6. How should overlapping clips resolve: last-wins, HTP for dimmer + LTP for others, or an explicit priority field?
7. Should strobe be stored as **Hz** or **note division** in the show document? Storing division requires BPM at evaluation time; storing Hz is BPM-independent but not musical after a tempo change.
8. What is the undo granularity for a drag: per pointer-move or one command per gesture? One per gesture is required for usable undo.
9. Do we need per-attribute fade times (console-style) or only clip-level dimmer fades? The current `Clip` has only `fadeInSec`/`fadeOutSec`.
10. Is a separate "cue" concept ever needed in the same document, or can cue-list mode compile from clips?

## Sources

- FL Studio manual, The Playlist: https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm
- Ableton Live 12 manual, Arrangement View: https://www.ableton.com/en/live-manual/12/arrangement-view/
- Avolites Titan manual, Cues: https://manual.avolites.com/docs/cues
- Avolites Titan manual, Cue Lists: https://manual.avolites.com/docs/cue-lists
- Avolites Titan manual, Cue List Timing: https://manual.avolites.com/docs/cue-lists/cue-list-timing
- Avolites Titan manual, Timelines: https://manual.avolites.com/docs/timelines
- Avolites Titan manual, Palettes: https://manual.avolites.com/docs/palettes
- Avolites Titan manual, Effects: https://manual.avolites.com/docs/effects
- Avolites Titan manual, Shape Generator: https://manual.avolites.com/docs/effects/shape-generator
- Avolites Titan manual, Pixel Mapper: https://manual.avolites.com/docs/effects/pixel-mapper
- Avolites Titan manual, Glossary: https://manual.avolites.com/docs/glossary
- grandMA3 manual, Cues and Sequences: https://help.malighting.com/grandMA3/2.2/HTML/cue_sequence.html
- grandMA3 manual, Sequence Sheet: https://help.malighting.com/grandMA3/2.2/HTML/cue_sequence_sheet.html
- ETC Eos Family v3.3.10 manual, Welcome: https://www.etcconnect.com/WebDocs/Controls/EosFamilyOnlineHelp/en/Content/01_Welcome/WELCOME_TO_EOS.htm
- ChamSys MagicQ manual, Cue Stack Settings: https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/cue_stack_settings.html
- ChamSys MagicQ manual, Cue Stacks/macros: https://docs.chamsys.co.uk/magicq/1.9.9.x/manual/cue_stacks.html
- Hog 4 v3.15 manual, Understanding Cuelists: https://www.etcconnect.com/webdocs/Controls/HOG/HTML/en/sect-cuelists_intro.htm
- Hog 4 v3.15 manual, Working with Tracking: https://www.etcconnect.com/webdocs/Controls/HOG/HTML/en/sect-ww_tracking.htm
- Wikipedia, Lighting control console (context for cues, chases, submasters): https://en.wikipedia.org/wiki/Lighting_control_console
