# Mobile Playback Plan

**Status:** Step 1 and touch pan/seek implemented (2026-10-22); Steps 2+ proposed.
**Scope:** make playback usable on phones by removing overlapping chrome.
Timeline *editing* gestures on touch are explicitly out of scope for this plan;
they get their own follow-up once playback reads cleanly.

## Why now

At ~380 px wide the app mostly works: the stage renders, the transport plays,
and the timeline is visible. What breaks is chrome density. Every control row is
a single non-wrapping flex line sized for desktop, so at phone widths the items
overlap instead of reflowing or disappearing.

Observed in a 390 × 844 portrait viewport:

| Area | Symptom |
| --- | --- |
| `#transport` | *New project*, *Edit project*, *Open project*, *Save project*, *Play*, the volume slider and *Collapse* are all on one line and paint over each other. |
| `#clip-inspector` | *Select* / *Drop*, the selection readout, the action select and the colour swatches collide; text from one control shows through another. |
| `#zoom-tools` | The floating bar spans almost the full width and sits on top of the lowest fixture lanes. |
| Stage overlays | *View* / *Orbit* are usable, but *Info* disappears entirely below 680 px, taking the only in-app explanation of the gestures with it. |

Root cause, per component:

- `#transport` (`app.css:552`) is `display: flex` with no `flex-wrap`. Buttons
  are `white-space: nowrap` (`:572`). A flex item's automatic minimum size is
  its min-content width, so nothing can shrink and the row overflows.
- The `@media (max-width: 680px)` block (`:1486`) sets `min-width: 0` on the
  buttons but not `min-width: 0` on the flex items' text, and does not remove
  any of the four project buttons — the widest offenders.
- `#clip-inspector` (`:606`) is also a single `flex` row. The 680 px block hides
  labels, the selection readout, and copy/paste/delete, but leaves the mode
  switch, action select, timing button and swatches, which still exceed 380 px.
- `#zoom-tools` (`:1025`) is absolutely positioned over the dock and its 680 px
  treatment only trims padding and the slider width. It stays ~320 px wide.
- `#transport-meta` is `display: none` below 680 px, so the playhead clock is
  lost even though it is the one piece of information playback needs.

## Decisions so far

- **Compact breakpoint:** width only, `max-width: 680px`. No
  `pointer: coarse` rules for now; that keeps the existing breakpoint model.
- **Mid breakpoint:** `480px`-`680px` gets a second, additive block, because
  the 375-430 px sacrifices leave the transport half empty at tablet-ish phone
  widths. It puts back the song name (`#transport-track`) and audio status next
  to the clock, widens the volume slider to 88 px and restores the `Loop`
  toggle in the zoom footer. Nothing is added that the narrow layout needs to
  hide again, so the two blocks stay independent.
- **Dock collapse control:** icon-only on phones, drawn as a CSS chevron
  (`::before` with rotated borders) rather than the `⌄` glyph, which sat off
  centre. It rotates to point up while `#timeline-dock.collapsed`; the label
  text stays in the DOM for `aria-expanded` and the tooltip.
- **Clip inspector:** keep the current feature set. It still has to stop
  overlapping, but controls are not being removed.
- **Project actions (`New` / `Edit` / `Open` / `Save`):** on phones they
  collapse behind a `Project ▾` disclosure menu (`ui/project-menu.ts`); the
  four buttons stay in the DOM under `#project-actions` and keep their own
  handlers, so the menu only forwards clicks. On desktop `#project-actions` is
  `display: contents` and both the toggle and menu are hidden.
- **Zoom vs. loop on phones:** zoom stays (`−`, range, `+`, `Fit`) because
  pinch-to-zoom on the timeline is not implemented; `Loop` and `Fit loop` are
  hidden.
- **Play button:** same box as the other transport buttons. It leads the row
  and keeps the accent tint, but no larger font or fixed width — a fixed width
  made it inconsistent with its neighbours and made Play/Pause shift.

## Principles

1. **Playback first on phones.** A phone gets a player: stage, play/pause,
   time, volume, loop, and a way to reach the editor. Everything else must be
   reachable, not necessarily visible.
2. **Hide, don't squash.** Shrinking 12 px controls to fit makes tap targets
   worse. Prefer removing a control from the default row and putting it behind
   one tap.
3. **One scroll axis.** No horizontally scrolling button rows; they hide
   controls with no affordance and fight the timeline's own horizontal scroll.
4. **CSS decides layout, JS decides structure.** Breakpoints live in CSS. JS is
   only used where the DOM must change (e.g. project actions moving into a
   menu).
5. **Desktop is untouched.** Every change is additive inside breakpoints or a
   compact-mode attribute; no desktop default changes.

## Proposed layout

### Width model

- Keep `max-width: 680px` as the compact breakpoint for the dock chrome.
- Do not add `pointer: coarse` rules yet. Controls that are too small for a
  finger are a Step 3 concern, not a layout-overlap concern.
- Landscape phones are wide but short, so vertical sizing is governed by
  `max-height` as well as width (see Dock and viewport).

### Transport (`#transport`)

Step 1 target, two rows, no overflow:

```
[ ▶ Play ]  [ 12:34 ]
[ New ] [ Edit ] [ Open ] [ Save ]  [ vol ] [ ⌄ ]
```

- Two rows via `flex-wrap: wrap` with explicit ordering, or an explicit grid.
  `min-width: 0` on the flex children so long labels ellipsise rather than
  widen the row.
- `#transport-meta` is *not* hidden; the clock stays and the song name/status
  drop to a single line only if there is room (hide `#transport-track` and
  `#audio-status` first, keep `#transport-time`).
- Project actions stay as individual buttons (deferred decision). A later
  step can collapse them into one `Project ▾` popover; the four click handlers
  already exist and the `#color-picker` / `#strobe-editor` pattern would fit.
- `#volume`: keep the range input, narrowed to fit. A mute button with a
  slider popover is a Step 2 option.
- `Collapse` can become icon-only (`⌄`) with an `aria-label` in Step 2; Step 1
  keeps its text if it fits.

### Clip inspector (`#clip-inspector`)

Keep every control. Step 1 wraps the row into two lines below 680 px — line 1
= `Select` / `Drop` + action select; line 2 = timing, colour swatches — and
removes the leftover empty `.inspector-target` gap (its children are already
hidden at this width).

A future playback-only mode may hide the inspector entirely, but that belongs
to the mobile-editing follow-up, alongside touch gestures for selecting and
moving clips.

### Zoom / loop tools (`#zoom-tools`)

- **Step 1:** keep every control and either wrap the bar's contents or move the
  bar out of the lane area. Anchoring bottom-right over lanes is what makes it
  overlap content; anchoring it above the lanes near the ruler fixes that with
  no feature loss. Do not let it span the full width of the dock.
- **Step 2:** trim it to `−  +  Fit  Loop`, dropping the zoom range, percent,
  `Fit loop` and `Follow`. Follow defaults to on and the playhead stays
  visible; users who turn it off can still scroll by touch.

### Stage overlays

- Keep `View` (top-right) and `Orbit` (bottom-right) as is in Step 1.
- Below 680 px, `#hint` is `display: none` (`:1507`). Step 2 replaces that with
  an icon-only `?` chip that opens the same `<details>` body as a sheet: the
  gesture documentation matters *more* on touch, not less.
- `#controls` popover: cap at `calc(100dvh - dock)` and allow internal scroll;
  it is already scrollable but uses `100vh` (Step 3).

### Dock and viewport

- `--dock-height: 50vh` on `max-width: 1000px` (`:1479`). Step 1 may need a
  slightly taller dock once the transport and inspector wrap; Step 3 switches
  it to `dvh` so mobile browser chrome does not resize the stage.
- Add a short-viewport variant: at `max-height: 500px` in landscape, cap the
  dock at ~40% and allow the whole dock to collapse to just the transport.
- Step 3 adds `viewport-fit=cover` to the meta tag and pads fixed chrome with
  `env(safe-area-inset-bottom/left/right)`, plus larger slider tracks/thumbs
  and 44 px tap targets.

## Milestones

Each step should be shippable on its own. Step 1 is the near-term work; Steps 2+
are deferred until it has been tried on a real phone.

### Step 1 — Stop the overlap, remove nothing (implemented)

The failure is overflow, not density: rows are `display: flex` with
`white-space: nowrap` children, so a flex item cannot shrink below its text
width and neighbours paint over each other. Step 1 makes every row fit and
accepts a taller dock.

What shipped in `apps/studio/src/styles/app.css` (`max-width: 680px`):

- `#transport` wraps into a single row of Play + `Project ▾` + clock + volume +
  caret. `display: contents` on `#project-actions` at desktop keeps the four
  buttons in the row there.
- The clock is retained; `#transport-track` and `#audio-status` are the only
  transport text hidden.
- `#clip-inspector` wraps into two lines and drops the empty
  `.inspector-target` gap. No controls removed.
- `#zoom-tools` becomes the dock's footer: a real fifth grid row
  (`grid-template-rows: auto auto minmax(0, 1fr) auto`) spanning the full dock
  width, so the timeline viewport ends above it instead of running underneath.
  The slider takes the leftover width (`flex: 1 1 auto`) and the buttons are
  34 px tall. The footer is hidden while the fixture side panel is open, since
  the remaining column is too narrow for a usable slider. `Loop` and
  `Fit loop` are hidden; `Follow` stays.
  - The base rule is `position: absolute; right: 14px; bottom: 12px`, so the
    mobile override must clear `left/right/bottom` to `auto` — as a relative
    grid item those offsets still shift it.
  - Because the bar is no longer floating over the lanes,
    `#arrangement-content` padding-bottom drops from 44 px to 8 px.

Two stacking consequences worth remembering:

- `#transport` needs `z-index: 14` on phones so the project dropdown is not
  painted under the arrangement's sticky ruler (`z-index: 6`).
- `#dock-resizer` therefore needs `z-index: 15`; without it the transport bar
  covers the resizer's lower half and the dock can no longer be dragged.

Verified at 320, 360, 390 and 430 px: one transport row, no document-level
horizontal scroll, menu items hit-test above the ruler, dock drag still works.
Desktop at 1400 px is unchanged.

### Touch gestures (implemented)

Playback on a phone needed a way to move the timeline without a middle button.
The touch layer lives in `main.ts` ("Touch panning") and only intercepts
`pointerType === 'touch'`, so mouse and pen behaviour is unchanged:

- **Drag horizontally on the time axis** (ruler, waveform or a fixture lane)
  pans the whole surface, exactly like middle-drag on desktop. A drag past
  8 px horizontally sets `pointerdown` capture on `#arrangement-scroll` and
  moves `scrollLeft`.
- **Tap on the ruler or waveform** seeks. The seek happens on `pointerup` so a
  pan can cancel it; previously the waveform seeked on `pointerdown`, which
  would fire at the start of every pan.
- **Vertical drags scroll the track list natively.** `touch-action` on
  `#arrangement-scroll`, the lanes, clips, ruler and waveform is `pan-y`, so
  the browser keeps vertical scrolling and hands horizontal drags to JS.
- **Excluded from the touch layer:** `.track-name` (fixture names, the
  visibility toggle, the venue button) and `#waveform-resizer`, which stay
  ordinary taps and drags.

Touch therefore does **not** start clip create/move/resize gestures. That is
deliberate: those gestures need their own touch design (drag-to-pan and
drag-to-move cannot share the same finger movement), which is the mobile-editing
follow-up.

### Step 2 — Reclaim height by hiding secondary chrome

Only after Step 1 has been used on a phone.

- Zoom pill: drop the zoom range, percent and `Follow` too; keep `−`, `+`,
  `Fit`. Zoom itself stays for the reason in the decisions above.
- Replace the hidden `#hint` below 680 px with a `?` chip that opens the same
  documentation as a sheet. Touch users need the gestures *more*, not less.
- Phone playback mode (`body[data-ui='playback']`): hide `#clip-inspector`
  entirely once editing on mobile has a home. Not part of Step 1, since the
  inspector is staying as is for now.
- Side panel as a full-screen overlay instead of a dock column.

### Step 3 — Touch ergonomics

- 44 px targets for transport, zoom, mode switch and swatches. Current
  controls are 20–24 px.
- `dvh` for `--dock-height` (`:1479` uses `50vh`) and for the `#controls`
  max-height (`:503` uses `100vh`), so mobile browser chrome does not resize
  the stage.
- `viewport-fit=cover` on the meta tag plus `env(safe-area-inset-*)` padding on
  fixed chrome.
- `overscroll-behavior: none` on the document to stop pull-to-refresh during
  timeline drags.

### Step 4 — Verification

- A Playwright checklist/screenshot run at 360 × 640, 390 × 844, 430 × 932 and
  844 × 390.
- Check: no overlapping text, no clipped labels, every control reachable, loop
  and play work through `window.__dmxsim`, side panel opens and closes.
- `npm run check` per the repo gate. No render benchmark: Step 1 only changes
  layout, not the frame path. Step 3 should still be eyeballed for stage size.

## Open decisions

1. **Volume on phones** — keep a compact slider (Step 1 keeps it) vs. a mute
   button with a slider popover in Step 2.
2. **Zoom bar placement** — pin above the lanes near the ruler (recommended,
   no hidden controls) vs. wrap it in place at the bottom of the dock.
3. **Side panel** — full-screen overlay in Step 2, or leave it as a narrowed
   dock column.

## Non-goals (follow-up plan)

- Touch gestures for creating, moving and resizing clips.
- Long-press context menus, marquee selection, pinch-to-zoom on the timeline.
- On-screen keyboard handling for the project/fixture dialogs.
- A dedicated landscape editing layout.
