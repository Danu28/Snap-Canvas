## [2026-08-11] SnapCanvas text tool — mousedown focus-steal cancels the textarea (real bug, user-reported twice) — Bug

Status: Fixed (verified with REAL input via CDP, 2026-08-11)

Details: Clicking the canvas with the Text tool created the textarea and
focused it, but the browser's mousedown DEFAULT ACTION (focus management) ran
immediately after pointerdown and moved focus back to body → synchronous blur
→ closeTextEditor("") → textarea removed, status "Text cancelled." → typing
did nothing. Synthetic dispatchEvent tests missed this (they don't run the
browser's real mousedown focus path); a REAL-input CDP driver (Input.
dispatchMouseEvent + insertText + dispatchKeyEvent) reproduced it exactly
(probe: pointerdown reaches canvas, status flips to "Text cancelled.").

Impact: High — text tool unusable in real browsers.

Next step: DONE — `event.preventDefault()` on the pointerdown in the text-open
branch (stops mousedown focus-change; pointer events spec: canceling
pointerdown suppresses compatibility mousedown default actions). Re-verified
with real input: textarea appears + stays focused, typing works, Enter
commits, red pixels rendered (106), zero errors. The earlier re-entrant-blur
fix (null-before-remove) was still a real fix (it was the Enter-path
NotFoundError) but NOT the user's "not working" cause — the focus steal was.
Applied: failures.md lesson `artifact:js:synthetic-events-miss-focus`.

## [2026-08-11] SnapCanvas text tool — re-entrant blur aborts Enter/Esc commit — Bug

Status: Fixed (headless-Chrome verified, 2026-08-11)

Details: In `closeTextEditor` (editor.js), `textEditor.remove()` ran BEFORE
nulling the state. `remove()` on the focused textarea fires a SYNCHRONOUS blur,
re-entering `closeTextEditor` via the blur listener; the guard saw the state
still set and called `remove()` a second time → uncaught `NotFoundError: The
node to be removed is no longer a child of this node` on every Enter/Esc
commit. In the user's browser this aborted the commit → text never added
("Adding text on image not working"). Headless repro confirmed the error at
line 327; commit survived in headless Chrome but threw every time.

Impact: High for the text tool (Enter/Esc path). Blur (click-away) path was
clean.

Next step: DONE — state nulled BEFORE remove() (classic re-entrancy fix) +
blur listener guarded with `if (textEditor)` + Enter now stopPropagation.
Headless Chrome: Enter commit renders text (221 px), blur commit renders
(223 px), ZERO window errors. Applied: failures.md lesson
`artifact:js:module-duplicate-declaration` N/A (different class); new lesson
for event-reentrancy added below.

## [2026-08-11] SnapCanvas editor blank white — duplicate `undo` killed the module (post-Pass regression) — Bug

Status: Fixed (root cause found + verified in headless Chrome, 2026-08-11)

Details: `editor.js` (a strict-mode ES module) had TWO `function undo()`
declarations (stale original at ~line 613 + new one at ~line 625, from the T6
edit). Duplicate function declarations are legal in sloppy mode but a
SyntaxError in modules → the module never evaluated → `initialize()` never
ran → status stuck at "Loading capture..." and the canvas stayed at its
default 300×150, showing the white canvas-wrap = "blank white image".
`node --check` missed it (sloppy mode); the verifier's full-file read was
truncated and didn't cover the duplicated region.

Impact: High — editor (and therefore every capture's display) completely
broken until this fix. Capture data itself was fine.

Next step: DONE — stale `undo` removed; editor re-verified in headless Chrome
(1200×800 buffer, fit-to-width zoom, correct quadrant pixels, status
"Ready to annotate"); CI hardened to parse all JS as .mjs (strict) so this
class is caught at the syntax gate (see failures.md lesson).

## [2026-08-11] SnapCanvas — stale drag state crashes pointermove on delete/undo mid-drag — Bug

Status: Fixed (verifier finding, re-verified 2026-08-11)

Details: In `editor.js`, `deleteSelected()` (Del) and `undo()`/`redo()` reset
`selectedIndex` but NOT `dragTarget` / `dragTextIndex` / `resizeState`. If a
pointer-captured drag/resize is in progress when the key is pressed, the next
`onPointerMove` dereferences `annotations[staleIndex]` → uncaught
`TypeError: Cannot read properties of undefined (reading 'type')`, which
poisons the handler (every subsequent move throws) until the editor reloads.
Repro: hold mouse down on an annotation (move or resize), press Del or Ctrl+Z,
then move the mouse. Confirmed by harness — exact error string.

Impact: Medium — requires the specific interaction, but then canvas editing is
dead until reload.

Next step: builder fix — reset drag state in deleteSelected/undo/redo (or guard
the pointermove dereferences); re-verify scope = editor.js drag-state handling.

Fixed 2026-08-11: `resetDragState()` added and called from undo/redo/deleteSelected
(abandons any in-flight drag/resize/draw). Repro harness re-run: Del mid-drag,
Ctrl+Z mid-text-drag, redo path — all PASS, no TypeError.

## [2026-08-11] Spurious "Error: Usage: /brainstorm on | off | status | toggle" mid-flow — Bug

Status: Investigating (root cause understood; fix in plan)

Details: With mode ON, some input hit the handler's default branch and showed
a bare usage error. Handler used exact-match on {on, off, status, toggle} —
any deviation (typo, shorthand, pasted description text) errors. Exact
keystroke not reproduced; the fix (fuzzy matching + received-args echo) makes
the class of failure impossible and diagnosable.

Impact: Confusing UX; user reported "extension not working" even though the
sampling mechanism is verified wired.

Next step: T1-T3 of plan (fuzzy resolver + echo) + T4 smoke test.

## [2026-08-11] "/brainstorm status - getting nothing" — Bug

Status: Fixed (root cause)

Details: `ctx.ui.notify(msg, "info")` maps to showStatus — a footer line that
is instantly overwritten; effectively invisible. The earlier usage error used
kind "error" (showError), which is why only that was visible. Also, a
mistyped command name silently falls through to the model as chat text
(agent-session.js:799-806).

Impact: User could not see status feedback; commands appeared dead.

Next step: resolved by warning-kind toasts + persistent widget + footer status
(already shipped); fuzzy matching prevents the silent-fallthrough confusion.

## [2026-08-11] Fixed-element scan: no measurable timing win — keep or revert? — Question

Status: Open

Details: T1 refactored the full-page capture fixed-element scan (live HTMLCollection + index loop + single explicit recalc) for performance. Equivalence is fully verified (H2: 1600/1600 hidden elements identical, metrics identical), but the timing on the synthetic 20k-element page is within noise (median 42.0ms old vs 46.0ms new; x0.91–1.07 across runs). Per-node getComputedStyle dominates and is irreducible without changing semantics.

Impact: None on correctness or features. The capture-side wins that matter are T2 (memory) and T3 (settle).

Next step: User decision — keep the cleaner, equivalence-verified scan, or revert T1 (one-line-ish git revert of that hunk). Either choice is safe; no re-verification needed if reverted (H2 would still pass — it tests equivalence, not implementation).
