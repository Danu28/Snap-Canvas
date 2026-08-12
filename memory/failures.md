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

Failure: Harness rigging silently invalid — the image-wait harness "didn't work" for two separate reasons that looked like real-code bugs: (a) `\"` inside a template-literal-embedded harness init (chrome-stub script injected via Page.addScriptToEvaluateOnNewDocument) collapsed to `"`, making the whole init a SyntaxError; Chrome registers the script without error and it never runs → `window.__pipeline.listener is not a function` errors that looked like a listener race. (b) An `<img>` with no src reports `complete === true` (spec: no-src imgs count as broken), so a no-src placeholder could never simulate a lazy-loading image — the wait-under-test was "always ready".

Prevention Rule: When a harness embeds test code in a backtick template literal, use single quotes for inner strings and re-read the generated source mentally (or print it); a silently-invalid init yields races-looking errors — probe the in-page state (typeof listener) BEFORE suspecting the code under test. To model an image that is genuinely still loading, hold its request open with CDP Network.setRequestInterception + continueInterceptedRequest, released at the right moment — never a no-src element. Verify negative controls actually load the modified file (check the served bytes), not the repo file.

sig: harness:init-template-escape / harness:img-complete-nosrc

Failure: Harness NaN in Input.dispatchMouseEvent — reading a RAW DOMRect through cdp evalJs (`getBoundingClientRect()` with returnByValue: true) silently produced an unserializable value → drag coords NaN → "Failed to deserialize params.x - BINDINGS: double value expected" crash. The existing editor-pixel harness always extracts plain objects in-page (`{left, top, width, height}`), which is why it never hit this.

Prevention Rule: Never return a DOMRect/DOMTokenList/Node straight out of Runtime.evaluate; extract plain-object fields in-page first (H1's pattern). A NaN/undefined coordinate surfaces as a CDP deserialize error at the FIRST Input call — verify the evalJs result before dispatching input.

sig: harness:domrect-returnbyvalue
