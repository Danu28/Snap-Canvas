# SnapCanvas — Bug List

Static review of the capture pipeline (`background.js`), the annotation editor
(`editor.js` + `editor.html`/`editor.css`), the content scripts
(`selection.js`, `element-picker.js`), and the popup (`popup.js`).

Severity: **High** = visible broken behavior vs documented feature.
**Medium** = wrong/leaky output or avoidable regression. **Low** = edge-case /
UX surprise.

Each bug is evidenced by `tests/bug-report.test.mjs` (the suite asserts the
*correct* behavior and fails, proving the defect exists).

---

## B1 — Multi-line text is not rendered (High)
**File:** `editor.js`
- `drawAnnotation` text branch (lines ~745–749):
  ```js
  if (a.type === "text") {
    ctx.font = `700 ${a.fontSize || FONT_SIZE}px Georgia, serif`;
    ctx.textBaseline = "top";
    ctx.fillText(a.value, a.x, a.y);   // single fillText, no newline handling
  }
  ```
- `hitTestText` (lines ~452–466) uses a single-row box: `const height = fontSize * 1.2;`

**Expected:** README and the editor hint promise *"multi-line"* text and *"Shift+Enter for a new line"*. `CanvasRenderingContext2D.fillText` renders **one line** and treats `\n` as whitespace, so multi-line input is silently flattened to a single line.
**Actual:** Only the first line is painted; newlines are lost. The hit-test box is also a single row, so multi-line text cannot be selected/moved correctly.
**Fix sketch:** split `a.value` on `\n`, draw each line at `y + i * lineHeight` (with `lineHeight ≈ fontSize * 1.2`), and compute the hit-box height across all lines.

---

## B2 — Selection handles leak into the exported/copied image (Medium-High)
**File:** `editor.js`, `renderComposite` (lines ~644–656)
```js
function renderComposite() {
  ...
  for (const a of annotations) drawAnnotation(a, compositeContext);
  drawHandles(compositeContext);   // <-- bakes selection UI into the PNG
  return composite;
}
```
`drawHandles` paints the orange corner squares (rectangles/arrows) and the
dashed selection outline (text). `renderComposite` is used by both
`downloadImage` (line ~896) and `copyImage` (line ~910).

**Expected:** The exported/copied PNG contains only the photo + annotations.
**Actual:** Whenever an annotation is *selected* at export time, the orange
selection handles/dashed outline are baked into the output file.
**Fix sketch:** do not call `drawHandles` inside `renderComposite` (or call it
with a flag and pass `false` for export).

---

## B3 — Element capture leaves the page scrolled (Medium)
**File:** `element-picker.js` (line ~129) + `background.js` `handleSelectedCapture` (lines ~125–142) / `captureTabWithoutScrollbars` (lines ~380–397)
```js
// element-picker.js
currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
...
// background.js — handleSelectedCapture / captureTabWithoutScrollbars
// never restores the scroll position
```
`captureFullPage` restores scroll in its `finally` block (lines ~197–227), but
the element-capture path does not.

**Expected:** After capturing an element, the user's page returns to where it was.
**Actual:** The page stays scrolled to the captured element (a side effect of
`scrollIntoView`), because the background capture never records/restores the
prior `scrollX/scrollY`.
**Fix sketch:** in the picker, capture `window.scrollX/scrollY` before
`scrollIntoView` and send them with the message; `handleSelectedCapture`
restores them after `captureTabWithoutScrollbars` (or have the picker restore
itself after the capture response).

---

## B4 — `Backspace` deletes the selected annotation from the page body (Low-Medium)
**File:** `editor.js`, `onKeyDown` (line ~1024)
```js
if (event.key === "Delete" || event.key === "Backspace") {
  deleteSelected();
  return;
}
```
**Expected:** A destructive delete shortcut should require intent (e.g. an
explicit selection *and* a deliberate action), and not hijack `Backspace` while
the user is simply interacting with the page body.
**Actual:** With any annotation selected and focus on the canvas/body (not an
input), pressing `Backspace` deletes it — surprising, and it also suppresses the
browser's normal `Backspace` behavior.
**Fix sketch:** drop `Backspace` from the binding (keep `Delete`), or only act
when the event target is the canvas, not the body.

---

## B5 — `cropSelectedArea` divides by `viewportWidth`/`viewportHeight` with no zero guard (Low)
**File:** `background.js`, `cropSelectedArea` (lines ~440–460)
```js
const scaleX = bitmap.width / rect.viewportWidth;
const scaleY = bitmap.height / rect.viewportHeight;
```
**Expected:** Crop math is safe if the reported viewport size is `0` (e.g. the
selection/capture races a layout that reports `innerWidth === 0`).
**Actual:** `scaleX = bitmap.width / rect.viewportWidth` becomes `Infinity`/`NaN`
when `viewportWidth` is `0`, producing an unusable crop (`ex`/`ey` go `NaN`,
`OffscreenCanvas(NaN, …)` throws or yields a blank image).
**Fix sketch:** guard with `const vw = rect.viewportWidth || 1;` (or bail out
with a clear error if the reported size is invalid).

---

## B6 (edge, Low confidence) — Full-page stitch can render transparent regions as black
**File:** `background.js`, `stitchTiles` (line ~402)
```js
const context = canvas.getContext("2d", { alpha: false });
```
**Expected:** A page without an opaque background composites so its empty areas
match what the user sees.
**Actual:** With `alpha: false` the canvas is opaque black; if
`captureVisibleTab` returns a PNG with transparent pixels (page with no
background color), those pixels stay black in the stitched output rather than
transparent/white. Most pages paint an opaque default, so this is an edge case.
**Fix sketch:** use `alpha: true` (or fill white first) before drawing tiles.

---

## Not bugs (verified)
- DPR scaling in `cropSelectedArea` is correct: `captureVisibleTab` returns a
  bitmap at `innerWidth * devicePixelRatio`, and `rect.viewportWidth` is
  `window.innerWidth`, so `scaleX` correctly equals `devicePixelRatio`.
- Photo `<img>` and annotation `<canvas>` are aligned (CSS sizes both to
  `captureImage.{width,height} * zoom`; `editor.css` makes the photo `inset:0`
  of the same `.canvas-stack`).
- `buildSteps` tile generation and `assertTabActive` tab-guard are correct.
- All five JS files pass `node --check` (no syntax errors).
- The real-Chrome harness (`harness/*.mjs`) does **not** cover B1, B2, B3, B4 —
  these are genuine untested gaps.
