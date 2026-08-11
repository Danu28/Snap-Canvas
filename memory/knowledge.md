## pi extension hooks (verified against @earendil-works/pi-coding-agent dist, 2026-08-11)

- `before_provider_request` fires in interactive sessions: `createAgentSession`
  (dist/core/sdk.js:205) wires Agent `onPayload` → `runner.emitBeforeProviderRequest`
  (dist/core/extensions/runner.js:776). Handler receives `{type, payload}` and
  its return value replaces the payload; handlers chain in extension load order.
- Payload shape: for `api: "openai-completions"` models it is the real request
  body (`params`) passed to `client.chat.completions.create` (pi-ai
  dist/api/openai-completions.js:130,543). `temperature` is only set when
  `options.temperature !== undefined` — a stamped value is honored.
- User's default model `deepseek-v4-flash` uses `api: openai-completions`
  (models-store.json) → the stamp reaches DeepSeek's OpenAI-compatible API.
- `pi-reasonix` also hooks `before_provider_request` but returns
  `{...payload, messages}` (spread) → preserves unknown fields, does not strip
  the stamp.
- Command dispatch: `_tryExecuteExtensionCommand` (dist/core/agent-session.js:924)
  parses `spaceIndex = text.indexOf(" ")`; commandName = text.slice(1, spaceIndex);
  args = text.slice(spaceIndex+1). If the command name is NOT registered, the
  command returns false and the text falls through to the model as a normal
  chat prompt (agent-session.js:799-806) — mistyped slash commands silently
  become chat messages.
- Notification kinds: `ctx.ui.notify(msg, "info")` → showStatus (footer line,
  subtle/easily overwritten); `"error"` → showError (prominent); `"warning"` →
  showWarning. Extension commands should use "warning" for status feedback.
- `ctx.ui.setWidget(key, string[] | undefined)` renders a persistent widget
  above the editor (pass undefined to clear); `ctx.ui.setStatus(key, text|undefined)`
  sets a footer status entry (pass undefined to clear).

## [2026-08-11] SnapCanvas — feature brainstorm (brainstormer skill)

Ranked ideas (see also `memory/` mismatch note: the five memory files in this repo
hold notes for a *different* project — a pi `/brainstorm` extension — not SnapCanvas)

1. **Editor zoom & pan** — fit-to-width default, wheel zoom, space-drag pan;
   unblocks annotating tall full-page captures (currently `max-width: 100%`
   shrinks them to postage-stamp size; `editor.js` `getCanvasPoint` must be
   reworked for zoom). Effort M. — **RECOMMENDED for planner**
2. **Annotation select/edit** — select/move/resize/delete/duplicate any
   annotation + redo; rects/arrows are currently permanent (only text is
   draggable). Effort M.
3. **Element picker capture** — context menu (needs `contextMenus` permission)
   → hover-highlight → capture single element with scroll-compensated rect.
   Effort M.
4. **Delayed/countdown capture** — 3/5/10 s timer for hover/dropdown states;
   timer must live in background since popup closes. Effort S.
5. **Inline text tool** — replace `window.prompt()` with in-canvas input +
   font-size picker + multiline. Effort S–M.

Flagged but not recommended: re-adding redact/pen/crop (removed deliberately in
commit `8097c65`), OCR (heavy WASM), infinite-scroll capture, background-tab
capture (view-window-scoped API).

Known bug worth fixing pre-features: `background.js:324` stores full-page PNG
`dataUrl`s in `chrome.storage.local` whose default quota is 10 MB — large page
captures fail silently and the editor shows "No captured image found"; fix =
`unlimitedStorage` permission.

## Candidate Requirements
- R1: Editor renders captures with fit-to-width default, wheel-zoom, and drag-pan;
  canvas-space coordinates remain correct at any zoom level.
- R2: Any annotation (rectangle, arrow, text) can be selected, moved, resized
  (rects), deleted, and duplicated; undo/redo covers all of it.
- R3: Right-clicking a page element offers "Capture element" which captures only
  that node (scroll-compensated, fixed-position-safe).
- R4: Popup offers 3/5/10 s delayed capture options; the countdown continues
  after the popup closes and the capture fires automatically.
- R5: Text annotation uses an in-canvas editor (no `window.prompt()`), supports
  font-size selection and multi-line values, and remains draggable.

## [2026-08-11] Gate 1 review — SnapCanvas candidate requirements (reviewer challenge)

Retained (with reasoning): R1 zoom/pan (verified problem: editor.css:163 max-width:100%);
R2 select/edit (kept incl. duplicate — flagged most-cuttable; arrow endpoint drag kept);
R4 delayed capture (clarified: background-owned timer, popup only displays countdown;
delay applies to full/visible only); R5 inline text; R6 storage bug (verified: storage.local
default quota 10 MB).

Revised: R3 element capture — dropped "scroll-compensated, fixed-position-safe" wording
(crop pipeline works on the visible-viewport capture; a fixed header covering the target
shows in the shot; only the element itself being fixed is safe). New wording: captures the
topmost hovered element as currently displayed, clamped to viewport; cross-origin iframes
captured as their box.

Removed: popup button for element capture (context menu only — one surface).

## SnapCanvas architecture facts (for builder/verifier sessions)

- MV3 extension, plain JS, no build step; files: manifest.json, background.js (capture
  pipeline), selection.js (selected-area overlay), editor.html/js/css (annotation studio),
  popup.html/js/css. Syntax gate: `node --check` each JS file.
- Capture: full = scroll-and-stitch (hides fixed/sticky elements), visible = one shot,
  selected = drag overlay → rect. All three store a dataUrl under `latestCapture` in
  chrome.storage.local, then open editor.html in a new tab.
- `captureVisibleTab` throttled at 600 ms (CAPTURE_THROTTLE_MS) with MAX_CAPTURE retry —
  never add parallel captures.
- `handleSelectedCapture` (background.js) = reusable rect→capture→crop→editor pipeline;
  `cropSelectedArea` clamps to viewport and scales by `viewportWidth/Height` sent with the
  rect. Editor `getCanvasPoint` maps client→canvas by width ratio — zoom via CSS
  display-size scaling keeps coordinates correct with zero math changes.
- Editor history: `commitHistory()` pushes cloned annotations; cap 50; `historyStack`.
  Text tool currently uses `window.prompt()` (being replaced by inline editor, plan T5).

## Gotcha: extension load verification

- Extensions live in `~/.pi/agent/extensions/*.ts` (global) and load via jiti.
  `/reload` hot-reloads them. Load with node + jiti from the pi bundle:
  `require('<pi>/node_modules/jiti')` createJiti(__filename) → import.
- `top_p` camelCase note: Google/Vertex APIs expect `generationConfig.topP`;
  `top_p` at top level only works for OpenAI-compatible endpoints (user is on
  DeepSeek, so fine).
