# SnapCanvas

SnapCanvas is a Chrome extension for capturing and annotating screenshots of the current page.

## Features

- Full page screenshot capture with scroll-and-stitch
- Visible area screenshot capture
- Selected area screenshot capture
- Element capture: right-click any page element → **Capture element**
- Delayed capture: 3 / 5 / 10 second countdown for hover and dropdown states (runs even if the popup closes)
- Keyboard shortcuts: `Ctrl+Shift+1` (full page), `Ctrl+Shift+2` (visible area), `Ctrl+Shift+3` (selected area)
- Annotation tools: rectangle, arrow, movable text, select, redaction (blur & pixelate)
  - Redaction: drag an area to blur or pixelate it; select/move/resize/delete/duplicate/undo/redo apply like any annotation; exports show exactly what the editor shows
  - Select tool: move, resize (rectangle corners, arrow endpoints), delete (`Del`), duplicate (`Ctrl+D`)
  - Inline text editing on the canvas (no browser prompt), multi-line, font size 14 / 22 / 32 px
- Editor zoom & pan: fit-to-width, mouse-wheel zoom (0.25x–8x), space-drag or middle-drag to pan
- Colors: green (default), red, blue, orange, black, white (fixed swatches)
- Undo / redo (`Ctrl+Z`, `Ctrl+Shift+Z`), copy image, and PNG download

## Limitations & notes

- **Fixed/sticky elements are omitted** from full-page captures. Elements with
  `position: fixed` or `position: sticky` are hidden while tiles are captured
  (otherwise they'd repeat in every tile) and so do not appear in the stitched
  output. Use a visible-area capture if the sticky header itself is the subject.
- **Element capture is viewport-bounded.** The element picker scrolls the target
  into view and captures the visible area; an element taller or wider than the
  viewport is not captured — the picker re-arms with a hint instead of shipping
  a clipped image. Use full-page capture for oversized elements.
- **Capture delay applies to Full page / Visible area only.** The 3/5/10s delay
  lets transient hover/dropdown UI settle before an automatic capture; it is
  meaningless for Selected-area (you control the capture moment by dragging), so
  the delay selector is disabled for that mode.
- **Tab switch cancels a capture.** Full-page capture aborts with an error if
  the active tab changes mid-capture rather than stitching the wrong page.

## Main Files

- `manifest.json`
- `background.js`
- `popup.html`
- `popup.css`
- `popup.js`
- `selection.js`
- `element-picker.js`
- `editor.html`
- `editor.css`
- `editor.js`
