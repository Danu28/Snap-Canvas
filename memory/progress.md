# Progress — SnapCanvas: performance optimization (behavior-preserving)

Plan: memory/plan.md (Rev 1 approved 2026-08-11 — perf scope; task list under `### Tasks (current)` is authoritative)

- [x] T0. Baseline harnesses (no code change) — pixel golden, scan eq+timing, move-path counters, mock-chrome pipeline  (verify: all four green on current code; golden + timings recorded — done 2026-08-11  (verify: H1 editor-pixel PASS — 12-step golden recorded (harness/golden-editor.json), move-burst drawImage delta=52, willReadFrequently:true captured, 0 page errors; H2 scan-eq PASS — 1600/1600 hidden set, old==new (x1.07 noise), median ~35ms; H4 pipeline PASS — stitch 12 rows × 300px exact, 982×3600, wall 4888ms, maxConcurrent=9, closed=1/9 (leak evidence) — passed))
  files: harness/ (new: lib/cdp.mjs, lib/server.mjs, lib/png.mjs, editor-pixel.mjs, scan-eq.mjs, pipeline.mjs)
- [x] T1. Optimize fixed-element scan (background.js)  (verify: hidden-node sets identical old-vs-new; faster with timing — done 2026-08-11  (verify: H2 scan-eq PASS — 1600/1600 hidden set identical, metrics identical, strict-.mjs syntax OK; timing within noise on synthetic page (median 42.0 vs 46.0ms, x0.91–1.07 across runs) — honest record: equivalence preserved, no measurable synthetic-page win; per-node getComputedStyle is irreducible without changing semantics; structural wins (no NodeList allocation, single explicit recalc) keep) — passed))
  files: background.js
- [x] T2. Bounded tile decode/stitch 4-worker pool (background.js)  (verify: max concurrency ≤ 4; every bitmap closed; pixels identical — done 2026-08-11  (verify: H4 pipeline PASS — maxConcurrent 4 (baseline 9), closed 9/9 (baseline 1/9), stitch runs identical (12 rows × 300px exact), dims 982×3600, wall 4908ms vs baseline 4888ms (no regression), strict-.mjs syntax OK — passed))
  files: background.js
- [x] T3. Scroll-settle 200→120 ms (background.js)  (verify: alignment harness — each row exactly once, no dup/skip/tear — done 2026-08-11  (verify: H4 pipeline PASS at 120ms — stitch runs identical (12 rows × 300px exact, no dup/skip/tear), dims 982×3600, wall 4806ms vs 4888 baseline; one-line revert if real-world seams appear — passed))
  files: background.js
- [x] T4. Editor photo-layer split (editor.html/css/js)  (verify: composite pixels identical to T0 golden; download/copy match — done 2026-08-11  (verify: H1 PASS with explicit golden comparison — 11/11 export-step hashes bit-identical to T0 golden (rect 3591490414 … move-burst 2644989867); move-burst drawImage delta 0 (baseline 52); zero page/runtime errors. Debug path: layer-split display composite differs by <=1 channel at anti-aliased edges (inherent two-layer rasterizer rounding, invisible); export reproduces old pixels exactly by re-rendering photo+annotations in a willReadFrequently context (matching the original editor context — proven by isolation + re-render tests) — passed))
  files: editor.html, editor.css, editor.js, harness/editor-pixel.mjs (golden reader now tests the real download path), harness/golden-editor-reference.json (new)
- [x] T5. Remove willReadFrequently + text-width cache (editor.js)  (verify: no hint; multi-text select/move identical; no getImageData — done 2026-08-11  (verify: display context first getContext hint = null (renderComposite keeps willReadFrequently deliberately for export bit-identity); grep: zero getImageData in editor.js; H1 golden compare PASS 11/11; move-burst drawImage delta 0; text measureText cached per (value,fontSize) via measureTextWidth, used by hitTestText + drawHandles — passed))
  files: editor.js
- [x] T6. Consolidation + final timing report  (verify: all harnesses green; full feature regression; report recorded — done 2026-08-11  (verify: H1 golden compare PASS 11/11 export steps; H2 scan-eq PASS (1600/1600 equivalence); H4 pipeline PASS (stitch 12 rows exact, concurrency 4, closed 9/9); move-bench large-canvas 2430.9ms -> 3.6ms per 200 moves (~675x); CI strict-.mjs gate PASS on all 5 JS files; manifest v3 unchanged permissions; report at harness/perf-report.json — passed))
  files: harness/ (perf-report.json, move-bench.mjs added; debug probes removed)

## Small scope 2026-08-12 — capture quality + speed (user request, post-plan; background.js only)

Plan (memory/plan.md) is complete; this is new scope approved via the lightweight flow. Three surgical changes in background.js, each traced to a measured finding; no new deps, no permission/format changes.

- [x] S1. Capture speed — CAPTURE_THROTTLE_MS 600 → 520 (Chrome API floor is 2 calls/sec = 500 ms; the MAX_CAPTURE retry staybacks overshoot)  (verify: H4 pipeline harness — wall 4213 ms vs 4789 ms baseline = 12.1% faster on an 8-tile page; stitch rows exact, concurrency 4, bitmaps closed — passed)
  files: background.js
- [x] S2. Capture quality — force `scroll-behavior: auto !important` during capture (injected style, removed with scrollbar-hide): real-Chrome pages with `scroll-behavior: smooth` animate `window.scrollTo`, so tiles can capture mid-scroll (torn seams)  (verify: H5 image-wait harness — capture-time computed scroll-behavior recorded 'auto' for every tile; negative control without the rule records 'smooth' — passed)
  files: background.js
- [x] S3. Capture quality — bounded wait (≤700 ms, 50 ms poll) for viewport-visible incomplete `<img>` elements before each full-page tile: kills blank-image tiles on lazy-loading pages; ~0 cost when images are loaded; broken/no-src imgs and the initial no-src state never stall the wait  (verify: H5 image-wait harness — page with an intercepted (held) img request: stitch contains the loaded image (yellow px), row colors preserved; negative control captures the blank placeholder — passed)
  files: background.js, harness/image-wait.mjs (new), harness/lib/cdp.mjs (stopChrome tree-kill on win32)

Measured: H4 wall 4789 → 4210-4213 ms (throttle padding was ~70% of capture wall time and was the dominant per-tile cost; settle 120 ms + double-rAF retained). Noted out of scope: editor double-decode of the stored dataUrl (loadImage + photo.src) — editor-load speed, different file.

## Previous scope (completed & verified 2026-08-11)

Plan: 5 ranked features + storage quota fix (archived in git 1374ae7; superseded by perf plan above)

- [v] T1. Storage quota fix (unlimitedStorage + explicit failure) — done 2026-08-11  (verify: >10 MB capture stores and opens; forced storage failure shows explicit error — error-path harness PASS; >10 MB real-browser case needs manual smoke test after reload — passed)
  files: manifest.json, background.js
- [v] T2. Element picker capture (contextMenus + element-picker.js + ELEMENT_SELECTED branch + CI check) — done 2026-08-11  (verify: right-click → highlight → click → editor shows exactly that element; Esc cancels; clamp/iframe behavior; menu no-ops on chrome:// — wiring harness PASS (menu creation, chrome:// gating, inject+BEGIN_ELEMENT_PICK, shared pipeline routing); interactive highlight/click + crop needs manual browser smoke test — passed)
  files: manifest.json, background.js, element-picker.js (new), .github/workflows/daily-check.yml
- [v] T3. Editor zoom & pan (fit-to-width, wheel 0.25–8x, space/middle-drag pan, % label) — done 2026-08-11  (verify: 400% zoom annotation lands at identical coords as 100%; download correct — coordinate-invariant harness PASS incl. zoom-to-cursor drift 0 after fixing scroll formula in onWheel; wheel/pan interaction + download need manual smoke test — passed)
  files: editor.html, editor.css, editor.js
- [v] T4. Inline text tool (overlay textarea, font-size select, no window.prompt) — done 2026-08-11  (verify: box at click point, multi-line commits, Esc cancels, drag still works — syntax PASS, no window.prompt remains, overlay position exact inverse of getCanvasPoint at zoom 3.7; typing/commit/Esc interaction needs manual smoke test — passed)
  files: editor.html, editor.css, editor.js
- [v] T5. Select tool + hit-testing + move (canvas-space handles) — done 2026-08-11  (verify: select/drag each type, handles, undo restores position — geometry harness PASS (distToSegment, bbox+topmost, handle hit zones, arrow segment); pointer interaction needs manual smoke test — passed)
  files: editor.html, editor.js
- [v] T6. Resize + delete + duplicate + redo (Ctrl+Z / Ctrl+Shift+Z) — done 2026-08-11  (verify: each op on-canvas; undo/redo round-trip exact; redo cleared on new edit; cap 50 — logic harness PASS (round-trip, redo-cleared, delete undoable, duplicate offset, stack cap 50); keyboard shortcuts need manual smoke test — passed)
  files: editor.html, editor.js
  [RE-VERIFY fix 2026-08-11] stale-drag crash (verifier finding): resetDragState() in undo/redo/deleteSelected — repro harness PASS (Del mid-drag, Ctrl+Z mid-text-drag, redo path)  files: editor.js
  [POST-PASS fix 2026-08-11] duplicate `function undo()` (module-killing SyntaxError, blank-white editor): stale copy removed — headless-Chrome harness PASS (editor renders test image, status "Ready to annotate"); CI hardened to strict .mjs parse  files: editor.js, .github/workflows/daily-check.yml
  [POST-PASS fix 2026-08-11] text-tool commit broken by re-entrant blur (NotFoundError on Enter/Esc): state nulled before remove() + guarded blur listener + Enter stopPropagation — headless-Chrome harness PASS (Enter commit 221 px, blur commit 223 px, zero window errors)  files: editor.js
  [POST-PASS fix 2026-08-11] text tool "not working" REAL cause: pointerdown created + focused the textarea, then the browser's mousedown default action stole focus → instant blur → "Text cancelled." → nothing added. Fixed with event.preventDefault() on the pointerdown in the text-open branch. Verified with REAL-input CDP driver (real mouse/typing/Enter): textarea appears + stays focused, "Hello" types, Enter commits, red pixels 106, zero errors  files: editor.js
  [FINAL VERIFY 2026-08-11] real-input CDP suite: text tool (appears/focus/type/Enter/commit, 106 px), rectangle drag (19197 px), select+move ("Annotation updated"), arrow drag (1945 px) — all zero runtime errors; strict .mjs parse ×5, logic harnesses ×7, crash repro, manifest, contract gate all PASS
- [v] T7. Delayed capture (popup 3/5/10 s, background-owned timer, countdown display) — done 2026-08-11  (verify: fires with dropdown open; popup close mid-countdown still fires; shortcuts stay instant — background-timer harness PASS (delay 0 → 2ms, 400ms respected, selected ignores delay); popup countdown display + dropdown-state capture need manual smoke test — passed)
  files: popup.html, popup.css, popup.js, background.js

## Archived (previous project — pi `/brainstorm` extension)
- [x] T1. Harden `/brainstorm` arg resolution — done 2026-08-11  (verify: resolver table test — passed)
- [x] T2. Add last-request stamp capture — done 2026-08-11  (verify: fake-pi harness — passed)
- [x] T3. Surface verification in status/widget/toast — done 2026-08-11  (verify: harness status-text asserts — passed)
- [ ] T4. Real smoke test — superseded (different project; memory adopted for SnapCanvas)
