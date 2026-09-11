# SnapCanvas — Bug List (Retired)

> **Status 2026-09-12: All bugs below are FIXED and verified by `tests/bug-report.test.mjs` (8/8 pass).**
> This file is kept as historical reference. Source of truth is now the tests + harness.
> See `suggestion.html` for the ordered enhancement plan (tasks 1–12).

Static review of the capture pipeline (`background.js`), the annotation editor
(`editor.js` + `editor.html`/`editor.css`), the content scripts
(`selection.js`, `element-picker.js`), and the popup (`popup.js`).

Severity: **High** = visible broken behavior vs documented feature.
**Medium** = wrong/leaky output or avoidable regression. **Low** = edge-case /
UX surprise.

Each bug was evidenced by `tests/bug-report.test.mjs` (the suite asserts the
*correct* behavior and fails, proving the defect exists). All now pass.

---

## B1 — Multi-line text is not rendered (High) — FIXED
**File:** `editor.js`
- `drawAnnotation` now splits on `\n` and draws each line at `y + i*lineHeight`
- `hitTestText` computes `height = lineHeight * lines.length`

## B2 — Selection handles leak into the exported/copied image (Medium-High) — FIXED
**File:** `editor.js`, `renderComposite` no longer calls `drawHandles`.

## B3 — Element capture leaves the page scrolled (Medium) — FIXED
**File:** `element-picker.js` captures `scrollX/scrollY` before `scrollIntoView`; `background.js handleSelectedCapture` restores it.

## B4 — `Backspace` deletes the selected annotation from the page body (Low-Medium) — FIXED
**File:** `editor.js`, `onKeyDown` now only binds `Delete` (no `Backspace`).

## B5 — `cropSelectedArea` divides by `viewportWidth`/`viewportHeight` with no zero guard (Low) — FIXED
**File:** `background.js`, `cropSelectedArea` guards with `|| 1`.

## B6 (edge) — Full-page stitch can render transparent regions as black — FIXED
**File:** `background.js`, `stitchTiles` uses `alpha:true` + white fill.

## B7 — Scroll-zoom removed (intentional) — DONE
`editor.js` no longer has wheel zoom; buttons Fit/−/+ remain. Verified by `tests/scroll-zoom-removed.test.mjs`.

---

## Not bugs (verified)
- DPR scaling in `cropSelectedArea` is correct
- Photo `<img>` and annotation `<canvas>` are aligned
- `buildSteps` tile generation and `assertTabActive` tab-guard are correct
- All five JS files pass `node --check`

## Follow-ups (now in suggestion.html)
P0: badge+lastError surfacing, IDB blob migration; P1: auto-save, sticky opt-out, crop-to-selection, accelerators, tile accelerate, burst-nudge grouping; P2: filename preview, dedupe, a11y polish. All implemented 2026-09-12.
