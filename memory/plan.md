# Plan: SnapCanvas — 5 ranked features + storage quota fix

## Restatement
User's intent: "create plan for all 5 ideas and a real latent bug fix" — implement the
five ranked brainstorm ideas for SnapCanvas (editor zoom & pan; annotation select/edit;
element picker capture; delayed/countdown capture; inline text tool) plus the fix for the
latent `chrome.storage.local` 10 MB quota bug on large captures.

## Acceptance Criteria
- R1: Editor renders captures at fit-to-width default with wheel-zoom (0.25–8x) and drag-pan; annotations drawn at any zoom level land at the same canvas-space coordinates as at 100%.
- R2: Any annotation can be selected, moved, resized (rect corners; arrow endpoints), deleted, and duplicated; Ctrl+Z / Ctrl+Shift+Z undo/redo covers every edit op.
- R3: Right-click → "Capture element" highlights the hovered element and captures exactly that node, clamped to the viewport (fixed/overlapping UI may appear in the crop — documented limitation; cross-origin iframes captured as their box).
- R4: Popup offers none/3/5/10 s delay; countdown is displayed in the popup and the capture still fires if the popup closes mid-countdown.
- R5: Text annotation edits inline on the canvas (no `window.prompt()`), supports font-size selection and multi-line values, and remains draggable.
- R6: Full-page captures larger than 10 MB store and open in the editor (`unlimitedStorage`); a storage failure surfaces an explicit error instead of "No captured image found".

## Design

### Feature set & ordering
Bug fix first (correctness), then the riskiest feature (element picker, independent of
editor), then the editor cluster in dependency-friendly order: zoom → inline text →
select/edit → delayed capture last (cheapest, independent). Every feature is verifiable
in isolation; no feature blocks another.

### D1 — Storage quota fix (T1)
`manifest.json` permissions += `unlimitedStorage` (lifts `storage.local` 10 MB quota).
`background.js` `storeCaptureAndOpenEditor` wraps `chrome.storage.local.set` in try/catch
and throws a human-readable error (propagated to popup status via existing `sendResponse`
error path). No data-format changes. NOTE: extension must be reloaded in
chrome://extensions for the new permission to take effect.

### D2 — Element picker capture (T2 spike, T3 impl)
- `manifest.json` permissions += `contextMenus`.
- `background.js`: create menu item once in `chrome.runtime.onInstalled`
  (`removeAll` → `create` with id `pagesnap-capture-element`, title "Capture element",
  contexts `["all"]`, on non-restricted pages). Menu click → active tab → inject
  `element-picker.js` (same pattern as `selection.js`).
- NEW `element-picker.js`: idempotent guard (`window.__pagesnapElementPickerLoaded`);
  on mousemove use `elementFromPoint`, walk up past zero-size nodes and
  HTML/BODY/SCRIPT/STYLE to a sensible target, draw a border-outline highlight +
  "Click to capture · Esc to cancel" pill (reuse selection.js overlay styling, z-index
  2147483647); on click send `{type:"ELEMENT_SELECTED", rect, viewportWidth,
  viewportHeight}` (rect from `getBoundingClientRect` — viewport space); Esc cancels.
- `background.js`: new message branch `ELEMENT_SELECTED` → same pipeline as
  `SELECTION_COMPLETE` → reuse `handleSelectedCapture` (captures visible tab, calls
  `cropSelectedArea` which already clamps to viewport and scales via viewport dims).
- Known limitations (document in code comment): cross-origin iframes are captured as
  their box (page's own document sees the iframe element); an element partially covered
  by a fixed/sticky overlay shows the overlay pixels in the crop (we crop the on-screen
  shot); oversized elements clamp to the viewport.

### D3 — Editor zoom & pan (T4)
- Zoom = CSS display-size scaling ONLY. `canvas.width/height` (the buffer) stays at
  natural capture resolution; set `canvas.style.width/height = natural * zoom`.
  `getCanvasPoint` in `editor.js` already maps client→canvas via
  `rect.width/height` ratio, so annotation coordinates stay correct at ANY zoom with
  zero math changes. Do NOT re-render the buffer and do NOT use `ctx.scale` (strokes
  would thicken).
- `.canvas-wrap` becomes the scrollable viewport (`overflow:auto`); canvas inside.
- State: `zoom` (clamped 0.25–8), default `fit-to-width` on load (zoom ≈ wrapWidth /
  naturalWidth × 0.98, min 0.1, max 1); wheel zooms to cursor; toolbar +/− buttons and
  zoom % label; pan via space+drag or middle-drag (translate `scrollLeft`/`scrollTop`).

### D4 — Inline text tool (T5)
- Delete the `window.prompt()` path (`editor.js:166`). On text-tool canvas click, show a
  positioned `<textarea>` overlay (absolute, font matches selection, color via
  `-webkit-text-fill-color`) at the click point; position computed by inverting
  `getCanvasPoint` (canvas-space → screen-space via `getBoundingClientRect` + zoom).
- Enter commits (Shift+Enter = newline), Esc cancels, blur commits. Committed annotation
  keeps the existing shape `{type:'text', x, y, value, color}` so hit-testing and drag
  (`dragTextIndex`) keep working unchanged.
- NEW font-size `<select>` in toolbar (14/22/32) applying to new text annotations only.

### D5 — Annotation select/edit (T6, T7)
- NEW "Select" tool button (4th tool). In select mode, pointerdown runs hit-testing,
  topmost match wins: rect = bbox inset test, arrow = point-to-segment distance ≤ 6 px,
  text = existing `hitTestText` bbox.
- Selected annotation renders selection handles (corner squares for rect; endpoint
  circles for arrow; bbox corners for text). Drag moves any type (reuse the existing
  `dragTextIndex` pattern generalized to `dragTarget`); rect corner drags resize (min
  8 px); arrow endpoint drags re-point.
- Keyboard: Del deletes selected, Ctrl+D duplicates with 20 px offset, Esc deselects.
- Redo: add `redoStack` mirroring `historyStack` (cap 50); undo pops → pushes redo;
  any new committed edit clears the redo stack; Ctrl+Shift+Z + a Redo button.
- All mutations go through `commitHistory()` as today.

### D6 — Delayed capture (T8)
- `popup.html`: `<select>` "Capture delay: none/3 s/5 s/10 s" above the action buttons.
- `popup.js`: sends `delayMs` in START_CAPTURE; for full/visible with delay > 0 keeps the
  popup open and renders a live countdown (setInterval), closing it at 0. Delay 0 keeps
  today's immediate-close behavior.
- `background.js` `handleCapture`: `await delay(delayMs)` before capture. The timer is
  background-owned, so closing the popup mid-countdown still fires the capture (the
  service worker's promise chain keeps it alive; 10 s is far under any kill threshold).
- Delay applies to full + visible ONLY; selected-area mode and Ctrl+Shift+1/2/3
  shortcuts stay immediate.

### Files touched
`manifest.json`, `background.js`, `editor.js`, `editor.html`, `editor.css`, `popup.js`,
`popup.html`, `popup.css`, NEW `element-picker.js`. `selection.js` unchanged.

### Load-bearing facts for the builder (do not re-derive)
- `getCanvasPoint` (editor.js) maps client→canvas by width ratio; zoom via display-size
  scaling keeps it correct — never change buffer size mid-session.
- History pattern (editor.js): `commitHistory()` pushes `cloneAnnotations`; cap 50.
- `handleSelectedCapture` (background.js) is the reusable rect→capture→crop→editor
  pipeline; `cropSelectedArea` clamps to viewport and scales by `viewportWidth/Height`
  sent with the rect — ELEMENT_SELECTED must send those dims.
- `captureVisibleTab` is throttled (CAPTURE_THROTTLE_MS=600, MAX_CAPTURE retry) — do not
  add parallel captures.
- Content-script idempotency guard pattern: `window.__pagesnap...Loaded` (see selection.js).
- Capture storage key: `latestCapture` in `chrome.storage.local`.
- Extension reload required after manifest changes (chrome://extensions → reload).
- No build step, no deps, plain JS — `node --check` on all JS files is the syntax gate.

## Quality Contract (Code artifact — no template section exists in memory/knowledge.md; written by planner)
1. No new dependencies, no build step; all touched JS passes `node --check`.
2. All 6 acceptance criteria verifiable via the task verify checks; existing flows
   (full/visible/selected capture; rect/arrow/text annotation; undo; copy; download)
   keep working — regression-checked per task.
3. Coordinate correctness: an annotation drawn at 400% zoom lands at the same canvas
   coords as at 100% (verify check T4).
4. Performance: zoom/pan/redraw stays smooth on an ~8000 px tall capture (CSS-scale,
   no buffer re-render, no per-frame allocation); element capture adds ≤ 1
   captureVisibleTab call.
5. New toolbar controls are real `<button>`/`<select>` elements with accessible labels;
   new keyboard shortcuts (Del, Ctrl+D, Ctrl+Z, Ctrl+Shift+Z, Esc, space+drag) do not
   collide with existing behavior.

## Tasks
T1. Fix storage quota: add `unlimitedStorage` to manifest permissions + surface storage.set failures in `storeCaptureAndOpenEditor` → verify: full-page capture of a page whose PNG exceeds 10 MB stores and opens in the editor (previously failed silently); a forced storage failure shows an explicit error in the popup, never "No captured image found"  (footprint: boundary — storage + permissions)
T2. Spike element-picker feasibility: probe `elementFromPoint` on fixed elements, cross-origin iframes, open/closed shadow DOM, oversized elements (throwaway test page, no committed code) → verify: findings confirm the D2 strategy (viewport-space getBoundingClientRect + clamp; iframe = box; overlay limitation accepted) and are recorded in knowledge.md before T3  (footprint: none)
T3. Element picker capture: `contextMenus` permission + onInstalled menu creation in background.js; NEW element-picker.js (guard, hover outline, click-to-capture, Esc); background ELEMENT_SELECTED branch reusing handleSelectedCapture → verify: right-click → "Capture element" → outline follows cursor → click → editor opens showing exactly that element; Esc cancels; oversized element clamps; a fixed-position element captures cleanly; cross-origin iframe captures as its box  (footprint: boundary — script injection on arbitrary pages)
T4. Editor zoom & pan: scrollable canvas-wrap, zoom state (fit-to-width default, wheel 0.25–8x zoom-to-cursor, +/− buttons, % label), space/middle-drag pan; buffer size and getCanvasPoint untouched → verify: wheel + buttons change zoom and canvas display size; pan reaches all corners of a tall capture; a rectangle drawn at 400% zoom lands at identical canvas coords as at 100%; downloaded PNG shows it in the right spot  (footprint: none)
T5. Inline text tool: remove window.prompt; overlay textarea editor (Enter commit, Shift+Enter newline, Esc cancel, blur commit); font-size select (14/22/32); annotation shape unchanged → verify: text box appears at the exact click point; multi-line value commits; chosen size/color renders; Esc cancels without creating an annotation; committed text still drags  (footprint: none)
T6. Select tool + hit-testing + move: new Select button; hitTest for rect bbox / arrow point-to-segment / text bbox; click selects topmost with handles; drag moves any type via generalized dragTarget; Esc deselects → verify: each type selects on click and drags smoothly; handles render only for the selected annotation; undo restores a moved annotation's position  (footprint: none)
T7. Resize + delete + duplicate + redo: rect corner resize (min 8 px), arrow endpoint re-point, Del deletes, Ctrl+D duplicates with 20 px offset; redoStack (cap 50, cleared on new edit) + Ctrl+Shift+Z + Redo button → verify: each op (resize, re-point, delete, duplicate) produces the expected on-canvas state; after an edit, Ctrl+Z then Ctrl+Shift+Z returns exactly to the pre-undo state for every op; after a new edit, Ctrl+Shift+Z performs no change (redo cleared); 51st edit drops the oldest history entry (undo count stays ≤ 50)  (footprint: none)
T8. Delayed capture: popup delay select (none/3/5/10 s) + live countdown display; START_CAPTURE carries delayMs; background awaits before capturing; full/visible only; shortcuts stay immediate → verify: 5 s delay shows countdown in popup and fires with a hover dropdown open; closing the popup mid-countdown still fires; Ctrl+Shift+1 stays immediate; selected-area ignores the delay  (footprint: none)

## Loop Budget
Re-verify cycles: 2

## Reflection
Pass (cycle 2/2, then 2 post-Pass fixes + final verify) — all 6 acceptance
criteria met. Post-Pass findings found by the user and fixed: (1) duplicate
`undo` module-killing SyntaxError (blank editor); (2) text tool — real cause
was the browser's mousedown focus-steal cancelling the new textarea
(preventDefault fix) plus re-entrant blur NotFoundError (null-before-remove
fix). Final verify used REAL-input CDP (real mouse/typing/Enter) across text,
rectangle, select/move, arrow — all pass, zero runtime errors. Manual items
still open for the user: zoom/pan feel, element-picker hover/click, countdown
display, >10 MB real capture (see progress.md).

## Revisions

## [2026-08-11] Rev 1: Gate 2 reviewer cuts (user approved)
- T2 (spike) merged into the element-picker task — the D2 strategy was already decided and
documented; a standalone probing task added a round-trip without changing the approach.
Edge-case probing (iframes, shadow DOM, oversized elements) happens in-impl, covered by the
task's verify checks.
- Element picker: menu click handler verifies the tab URL is http/https before injecting
(context menus can appear on restricted pages where scripting.executeScript fails).
- CI: element-picker.js added to the daily-check.yml `node --check` list (new file would
otherwise never be syntax-gated).
- Selection handles (T5/T6) drawn in canvas space so zoom scaling is free — no DOM-overlay
coordinate math.

### Tasks (current)
T1. Fix storage quota: add `unlimitedStorage` to manifest permissions + surface storage.set failures in `storeCaptureAndOpenEditor` → verify: full-page capture of a page whose PNG exceeds 10 MB stores and opens in the editor (previously failed silently); a forced storage failure shows an explicit error in the popup, never "No captured image found"  (footprint: boundary — storage + permissions)
T2. Element picker capture: `contextMenus` permission + `onInstalled` menu creation (id `pagesnap-capture-element`, contexts `["all"]`); menu click verifies tab URL is http/https before injecting; NEW element-picker.js (idempotent guard, hover outline via elementFromPoint, walk-up target selection, click-to-capture, Esc cancel, edge-case probing in-impl); background `ELEMENT_SELECTED` branch reusing handleSelectedCapture; add element-picker.js to daily-check.yml node --check list → verify: right-click → "Capture element" → outline follows cursor → click → editor opens showing exactly that element; Esc cancels; oversized element clamps; fixed-position element captures cleanly; cross-origin iframe captures as its box; menu no-ops on chrome:// pages; CI workflow includes the new file  (footprint: boundary — script injection on arbitrary pages)
T3. Editor zoom & pan: scrollable canvas-wrap, zoom state (fit-to-width default, wheel 0.25–8x zoom-to-cursor, +/− buttons, % label), space/middle-drag pan; buffer size and getCanvasPoint untouched → verify: wheel + buttons change zoom and canvas display size; pan reaches all corners of a tall capture; a rectangle drawn at 400% zoom lands at identical canvas coords as at 100%; downloaded PNG shows it in the right spot  (footprint: none)
T4. Inline text tool: remove window.prompt; overlay textarea editor (Enter commit, Shift+Enter newline, Esc cancel, blur commit); font-size select (14/22/32); annotation shape unchanged → verify: text box appears at the exact click point; multi-line value commits; chosen size/color renders; Esc cancels without creating an annotation; committed text still drags  (footprint: none)
T5. Select tool + hit-testing + move: new Select button; hitTest for rect bbox / arrow point-to-segment / text bbox; click selects topmost with handles drawn in canvas space; drag moves any type via generalized dragTarget; Esc deselects → verify: each type selects on click and drags smoothly; handles render only for the selected annotation; undo restores a moved annotation's position  (footprint: none)
T6. Resize + delete + duplicate + redo: rect corner resize (min 8 px), arrow endpoint re-point, Del deletes, Ctrl+D duplicates with 20 px offset; redoStack (cap 50, cleared on new edit) + Ctrl+Shift+Z + Redo button → verify: each op (resize, re-point, delete, duplicate) produces the expected on-canvas state; after an edit, Ctrl+Z then Ctrl+Shift+Z returns exactly to the pre-undo state for every op; after a new edit, Ctrl+Shift+Z performs no change (redo cleared); 51st edit drops the oldest history entry (undo count stays ≤ 50)  (footprint: none)
T7. Delayed capture: popup delay select (none/3/5/10 s) + live countdown display; START_CAPTURE carries delayMs; background awaits before capturing; full/visible only; shortcuts stay immediate → verify: 5 s delay shows countdown in popup and fires with a hover dropdown open; closing the popup mid-countdown still fires; Ctrl+Shift+1 stays immediate; selected-area ignores the delay  (footprint: none)
