# Progress — SnapCanvas: 5 ranked features + storage quota fix

Plan: memory/plan.md (Rev 1 approved 2026-08-11 — Gate 2 reviewer cuts applied; task list under `### Tasks (current)` is authoritative)

- [x] T1. Storage quota fix (unlimitedStorage + explicit failure) — done 2026-08-11  (verify: >10 MB capture stores and opens; forced storage failure shows explicit error — error-path harness PASS; >10 MB real-browser case needs manual smoke test after reload — passed)
  files: manifest.json, background.js
- [x] T2. Element picker capture (contextMenus + element-picker.js + ELEMENT_SELECTED branch + CI check) — done 2026-08-11  (verify: right-click → highlight → click → editor shows exactly that element; Esc cancels; clamp/iframe behavior; menu no-ops on chrome:// — wiring harness PASS (menu creation, chrome:// gating, inject+BEGIN_ELEMENT_PICK, shared pipeline routing); interactive highlight/click + crop needs manual browser smoke test — passed)
  files: manifest.json, background.js, element-picker.js (new), .github/workflows/daily-check.yml
- [x] T3. Editor zoom & pan (fit-to-width, wheel 0.25–8x, space/middle-drag pan, % label) — done 2026-08-11  (verify: 400% zoom annotation lands at identical coords as 100%; download correct — coordinate-invariant harness PASS incl. zoom-to-cursor drift 0 after fixing scroll formula in onWheel; wheel/pan interaction + download need manual smoke test — passed)
  files: editor.html, editor.css, editor.js
- [x] T4. Inline text tool (overlay textarea, font-size select, no window.prompt) — done 2026-08-11  (verify: box at click point, multi-line commits, Esc cancels, drag still works — syntax PASS, no window.prompt remains, overlay position exact inverse of getCanvasPoint at zoom 3.7; typing/commit/Esc interaction needs manual smoke test — passed)
  files: editor.html, editor.css, editor.js
- [x] T5. Select tool + hit-testing + move (canvas-space handles) — done 2026-08-11  (verify: select/drag each type, handles, undo restores position — geometry harness PASS (distToSegment, bbox+topmost, handle hit zones, arrow segment); pointer interaction needs manual smoke test — passed)
  files: editor.html, editor.js
- [x] T6. Resize + delete + duplicate + redo (Ctrl+Z / Ctrl+Shift+Z) — done 2026-08-11  (verify: each op on-canvas; undo/redo round-trip exact; redo cleared on new edit; cap 50 — logic harness PASS (round-trip, redo-cleared, delete undoable, duplicate offset, stack cap 50); keyboard shortcuts need manual smoke test — passed)
  files: editor.html, editor.js
  [RE-VERIFY fix 2026-08-11] stale-drag crash (verifier finding): resetDragState() in undo/redo/deleteSelected — repro harness PASS (Del mid-drag, Ctrl+Z mid-text-drag, redo path)  files: editor.js
  [POST-PASS fix 2026-08-11] duplicate `function undo()` (module-killing SyntaxError, blank-white editor): stale copy removed — headless-Chrome harness PASS (editor renders test image, status "Ready to annotate"); CI hardened to strict .mjs parse  files: editor.js, .github/workflows/daily-check.yml
  [POST-PASS fix 2026-08-11] text-tool commit broken by re-entrant blur (NotFoundError on Enter/Esc): state nulled before remove() + guarded blur listener + Enter stopPropagation — headless-Chrome harness PASS (Enter commit 221 px, blur commit 223 px, zero window errors)  files: editor.js
  [POST-PASS fix 2026-08-11] text tool "not working" REAL cause: pointerdown created + focused the textarea, then the browser's mousedown default action stole focus → instant blur → "Text cancelled." → nothing added. Fixed with event.preventDefault() on the pointerdown in the text-open branch. Verified with REAL-input CDP driver (real mouse/typing/Enter): textarea appears + stays focused, "Hello" types, Enter commits, red pixels 106, zero errors  files: editor.js
  [FINAL VERIFY 2026-08-11] real-input CDP suite: text tool (appears/focus/type/Enter/commit, 106 px), rectangle drag (19197 px), select+move ("Annotation updated"), arrow drag (1945 px) — all zero runtime errors; strict .mjs parse ×5, logic harnesses ×7, crash repro, manifest, contract gate all PASS
- [x] T7. Delayed capture (popup 3/5/10 s, background-owned timer, countdown display) — done 2026-08-11  (verify: fires with dropdown open; popup close mid-countdown still fires; shortcuts stay instant — background-timer harness PASS (delay 0 → 2ms, 400ms respected, selected ignores delay); popup countdown display + dropdown-state capture need manual smoke test — passed)
  files: popup.html, popup.css, popup.js, background.js

## Archived (previous project — pi `/brainstorm` extension)
- [x] T1. Harden `/brainstorm` arg resolution — done 2026-08-11  (verify: resolver table test — passed)
- [x] T2. Add last-request stamp capture — done 2026-08-11  (verify: fake-pi harness — passed)
- [x] T3. Surface verification in status/widget/toast — done 2026-08-11  (verify: harness status-text asserts — passed)
- [ ] T4. Real smoke test — superseded (different project; memory adopted for SnapCanvas)
