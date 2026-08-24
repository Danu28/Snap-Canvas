# Plan — Remove scroll-wheel zoom from the editor

## Problem Statement
SnapCanvas's annotation editor supports zooming via the mouse wheel
(`onWheel`: scroll up = zoom in, scroll down = zoom out). The user wants this
scroll-zoom feature removed. The dedicated zoom buttons (+ / − / Fit) must stay.

## Assumptions
- "scroll zoom in and zoom out feature" = the wheel/scroll zoom handler only,
  not the zoom buttons (zoomInButton / zoomOutButton / fitButton).
- No other behavior changes; pan (space/middle-drag) and button zoom remain.
- Verification is the source-encoding test suite + `node --check` (no browser).

## Acceptance Criteria
1. `bindEvents` no longer registers a `wheel` listener on `canvasWrap`.
2. The `onWheel` function is removed from `editor.js`.
3. Zoom buttons are retained (`zoomInButton`, `zoomOutButton`, `fitButton`
   listeners still present) — guard against over-removal.
4. `node --check` passes on `editor.js`; `node --test tests/scroll-zoom-removed.test.mjs` passes.

## Task List
- [x] Write plan.md
- [x] Write tests/scroll-zoom-removed.test.mjs (fails: wheel zoom still present)
- [x] Remove the `wheel` listener registration in bindEvents
- [x] Remove the `onWheel` function
- [x] Run tests + node --check; confirm green

## Test Plan
Command: `node --test tests/scroll-zoom-removed.test.mjs`
- "scroll-wheel zoom is removed" → asserts editor.js has no `addEventListener("wheel"` and no `function onWheel`.
- "zoom buttons retained" → asserts zoomInButton / zoomOutButton / fitButton listeners still present.
