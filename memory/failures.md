# Failure Memory

## Quality Failures

Failure: `node --check` (sloppy mode) accepted duplicate `function undo()`
declarations in editor.js — a strict-mode ES module — so the whole module
failed to evaluate at runtime (SyntaxError), leaving the editor stuck at
"Loading capture..." with a blank white canvas. Shipped past build + verify.

Prevention Rule: Parse every extension JS file as ESM in the syntax gate —
`cp f.js /tmp/f.mjs && node --check /tmp/f.mjs` (`.mjs` forces strict mode;
plain `node --check` is sloppy and misses module-only redeclarations). The
verifier must also treat a truncated full-file read as a gap, not evidence,
for the region it didn't cover.

sig: artifact:js:module-duplicate-declaration

Failure: `Element.remove()` on a focused textarea fires a synchronous `blur`
event; the blur handler re-entered the same close-function before its state
was nulled, calling `remove()` twice → uncaught `NotFoundError: ... no longer
a child of this node` on every commit, which aborted the commit in the user's
browser (text tool "not working").

Prevention Rule: When an event listener (blur/keydown) can re-enter a cleanup
function, null the object state BEFORE the DOM mutation that fires the event
(remove/blur), and guard every listener that reads that state
(`if (textEditor) ...`). Verify event-driven flows with a real DOM (headless
Chrome), not just logic replicas — the harness caught this where node --check
cannot.

sig: artifact:js:blur-reentrancy-remove

Failure: Synthetic DOM tests (dispatchEvent with PointerEvent/KeyboardEvent)
passed the text-tool flow, but a REAL browser click still failed: creating +
focusing a textarea inside a pointerdown handler, without preventDefault,
lets the browser's mousedown focus-management run after pointerdown and steal
focus → instant blur → the new textarea was cancelled before the user could
type. Real-input CDP testing caught it instantly.

Prevention Rule: Any pointerdown handler that creates/focuses a focusable
widget (textarea, input, dialog) must call `event.preventDefault()` on the
pointerdown, or the compatibility mousedown will move focus and blur the new
widget. Verify user-interaction flows with REAL input (CDP
Input.dispatchMouseEvent/insertText/dispatchKeyEvent, or Puppeteer), never
synthetic dispatchEvent alone — the browser's default actions (focus, click
synthesis) don't run for synthetic events.

sig: artifact:js:synthetic-events-miss-focus
