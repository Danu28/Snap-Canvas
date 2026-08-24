# Plan — Fix all SnapCanvas bugs

## Problem Statement
`BUGS.md` lists six bugs in SnapCanvas (a Chrome MV3 screenshot + annotate
extension). This run fixes all of them with the smallest correct change per
bug: B1 multi-line text, B2 selection handles in export, B3 element-capture
leaves page scrolled, B4 Backspace deletes from body, B5 zero-viewport crop
division, B6 transparent regions render black in full-page stitch.

## Assumptions
- Fix only the bugs in `BUGS.md`; no new features or refactors.
- B6 (edge/low confidence) is still a real defect and is fixed.
- The existing `tests/bug-report.test.mjs` asserts the *correct* behavior and
  currently fails; after fixes it must pass (it is the regression suite).
- A real browser is unavailable here, so verification is the source-encoding
  test suite plus `node --check` on changed files.

## Acceptance Criteria
1. `drawAnnotation` renders text across `\n` lines; `hitTestText` and the text
   selection outline cover all lines.
2. `renderComposite` does not call `drawHandles` (no selection chrome in export).
3. `handleSelectedCapture` restores the prior scroll after an element capture.
4. `onKeyDown` no longer binds `Backspace` to delete.
5. `cropSelectedArea` guards a zero `viewportWidth`/`viewportHeight`.
6. `stitchTiles` no longer paints transparent page regions as black.
7. `node --test tests/bug-report.test.mjs` passes all tests; changed JS files
   pass `node --check`.

## Task List
- [x] Rewrite plan.md
- [x] Add B6 test to tests/bug-report.test.mjs
- [x] Fix B1: multi-line text (drawAnnotation, hitTestText, drawHandles)
- [x] Fix B2: remove drawHandles from renderComposite
- [x] Fix B4: drop Backspace binding in onKeyDown
- [x] Fix B3: capture+restore scroll (element-picker.js + handleSelectedCapture)
- [x] Fix B5: zero-guard cropSelectedArea
- [x] Fix B6: stitchTiles alpha/fill
- [x] Run tests + node --check; confirm green

## Test Plan
Command: `node --test tests/bug-report.test.mjs`
- B1: asserts source splits text on `\n`.
- B2: asserts `renderComposite` omits `drawHandles`.
- B3: asserts `handleSelectedCapture` restores scroll (`scrollTo`).
- B4: asserts editor source has no `"Backspace"` delete binding.
- B5: asserts `cropSelectedArea` guards zero `viewportWidth`.
- B6: asserts `stitchTiles` does not use `alpha: false`.
Also: `node --check` each changed `.js` (run as `.mjs`).
