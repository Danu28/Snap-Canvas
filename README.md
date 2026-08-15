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
