# Plan — SnapCanvas bug review

## Problem Statement
SnapCanvas is a Chrome MV3 extension that captures screenshots (full page /
visible / selected-area / element) and opens an editor to annotate (rectangle,
arrow, text, blur/pixelate redaction, select/move/resize, undo/redo, export).
The task is a **static code review**: read the repository, find bugs, and list
them. "Done" = an evidenced list of every bug found, each grounded in the code
with file/line, expected vs actual behavior, and severity. This task asks to
**list** bugs, not to fix them.

## Assumptions
- "Bug" = a defect against documented/intended behavior or correct engineering
  (not a style nit or a feature request).
- The deliverable is the bug list; no code fixes are required by the task.
- A real browser/extension runtime is not available here, so verification is by
  close source reading plus a source-encoding test script (no Chrome needed).

## Acceptance Criteria
1. A `BUGS.md` file exists listing every bug found.
2. Each bug cites its file + line, states expected vs actual, and a severity.
3. `tests/bug-report.test.mjs` encodes the *correct* (spec) behavior and **fails**
   — proving the bugs exist in the current source (these are bug-existence
   tests, so they stay red by design since the task is to list, not fix).
4. No false positives: every entry is grounded in actual source.

## Task List
- [x] Read & trace capture pipeline (`background.js`)
- [x] Read & trace editor (`editor.js`) + `editor.html`/`editor.css`
- [x] Read content scripts (`selection.js`, `element-picker.js`) + `popup.js`
- [x] Identify bugs per file
- [x] Write `tests/bug-report.test.mjs` (fails for the right reason)
- [x] Write `BUGS.md` deliverable
- [x] Run tests; confirm failures map to the listed bugs
- [x] Report

## Test Plan
Command: `node --test tests/bug-report.test.mjs`
The suite reads the source files and asserts the *correct* behavior; each test
fails because the current code violates it. These tests prove the bugs exist:
- `text renders multiple lines` — asserts text-draw splits on `\n` (Bug B1).
- `export omits selection handles` — asserts `renderComposite` does not call
  `drawHandles` (Bug B2).
- `element capture restores scroll` — asserts the element-capture path restores
  scroll position (Bug B3).
- `Backspace not bound to delete in body` — asserts editor keydown does not map
  `Backspace` to delete (Bug B4).
- `crop guards zero viewport size` — asserts `cropSelectedArea` guards a zero
  `viewportWidth` (Bug B5).
