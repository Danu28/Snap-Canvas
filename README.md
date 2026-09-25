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
  - Inline text editing on the canvas (no browser prompt), multi-line, font size 8–200 px (stepper)
  - Crop to selection: select a rectangle/redaction then Crop to Selection (shifts annotations, undoable)
  - Auto-save: annotations auto-saved to session storage, restores on reload
  - Tool accelerators: R/A/T/S/B/P/0 (fit) and ? help
- Editor zoom & pan: fit-to-width (0), zoom 0.25x–8x, space-drag or middle-drag to pan
- Colors: green (default), red, blue, orange, black, white (fixed swatches)
- Undo / redo (`Ctrl+Z`, `Ctrl+Shift+Z`), copy image, and PNG download

## Limitations & notes

- **Fixed/sticky elements are omitted** from full-page captures by default. Elements with
  `position: fixed` or `position: sticky` are hidden while tiles are captured
  (otherwise they'd repeat in every tile). Check **Include sticky header** in the popup to keep sticky headers visible (fixed still hidden).
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

## Permissions (justified)

- `activeTab` — capture the current tab’s visible pixels.
- `tabs` — resolve `tabId`/`windowId` and guard `assertTabActive` (abort if user switches tabs mid-stitch); `getTabMeta` for filename/domain. No broad host access.
- `scripting` — inject `selection.js` / `element-picker.js` and hide fixed/sticky + scroll for stitching.
- `storage` / `unlimitedStorage` — store last capture + IndexedDB fallback for large PNGs (>6 MB quota) + auto-save and settings.
- `downloads` — save annotated PNG.
- `clipboardWrite` — Copy Image.
- `contextMenus` — right-click → Capture element.
- CSP: `script-src 'self'; object-src 'none'` (see `manifest.json`).

## Main Files

- `manifest.json` (MV3, `content_security_policy` hardened)
- `background.js` — capture orchestrator (throttled stitch, IDB fallback, tab-guard)
- `popup.html` / `popup.css` / `popup.js` — capture UI, history, settings
- `selection.js` — selected-area overlay (DOM-API, no innerHTML)
- `element-picker.js` — element picker (DOM-API, no innerHTML)
- `editor.html` / `editor.css` / `editor.js` — annotation studio
- `modules/history.js`, `modules/redact.js`, `modules/zoom.js`, `modules/annotations.js` — modularized editor helpers (P2)
- `shared.js` — filename builder (single source)
