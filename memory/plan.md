# Plan: SnapCanvas performance — capture + editor hot paths (behavior-preserving)

## Restatement
Optimize SnapCanvas's performance — faster full-page capture and faster editor interaction on large captures — while preserving **every existing feature and its observable behavior exactly** (capture modes, annotation tools, zoom/pan, undo/redo, delayed capture, element picker, storage). No UI, data-format, or permission changes.

## Acceptance Criteria
- R1: Full-page capture output is identical (same hidden-element semantics, same stitch math) and the fixed-element scan is measurably faster.
- R2: Full-page stitch memory is bounded (tile decode concurrency ≤ 4, every bitmap closed) with pixel-identical stitched output.
- R3: Editor pointermove work no longer redraws the photo (structural: zero drawImage per move during interactions) and composite output is pixel-identical to baseline.
- R4: Every existing feature behaves identically: 4 capture modes, element picker, delayed capture, all annotation tools, select/move/resize, undo/redo/delete/duplicate, zoom/pan, download, copy, storage.
- R5: Measured before/after improvement is reported for every touched hot path.

## Tasks
T0. Baseline harnesses (no code change) — headless-Chrome pixel/behavior harness (scripted annotation session → canvas composite golden), scan equivalence+timing harness (old scan copy vs new), move-path instrumentation harness (drawImage/getContext counters), mock-chrome capture pipeline harness → verify: all four green on current code; golden + timings recorded for later diff  (footprint: none)
T1. Optimize fixed-element scan (background.js): single forced style recalc + live getElementsByTagName collection reading only style.position; hide/restore semantics verbatim → verify: hidden-node sets identical old-vs-new on synthetic pages (inline-fixed, stylesheet-fixed, sticky, nested); new scan faster with timing recorded  (footprint: hot-path)
T2. Bounded tile decode/stitch (background.js): 4-worker pool + bitmap.close() after each draw → verify: mock-chrome harness asserts max concurrent decodes ≤ 4 and every bitmap closed before resolve; stitched pixels identical to sequential reference  (footprint: hot-path)
T3. Scroll-settle 200→120 ms (background.js SCROLL_SETTLE_MS) → verify: stitch-alignment harness on synthetic tall page — each distinct row captured exactly once, no duplicate/skipped/torn rows; full capture pipeline harness green  (footprint: hot-path)
T4. Editor photo-layer split (editor.html/css/js): stacked editorPhoto img under canvas, redraw() drops photo draw, renderComposite() for download/copy → verify: scripted session (rect/arrow/text, select-move, resize, undo/redo, delete, duplicate, zoom-in) composite pixels identical to T0 golden; download/copy produce matching pixels; move-path harness green  (footprint: hot-path)
T5. Remove willReadFrequently + text-width cache (editor.js): context hint removed; measureText results cached keyed by value+fontSize → verify: getContext-hint recorder shows no hint; multi-annotation text select/move identical to golden; no getImageData anywhere in editor.js  (footprint: hot-path)
T6. Consolidation — re-run all harnesses + full feature regression (capture modes, element picker, delay countdown, shortcuts wiring, CI syntax gate) + final before/after timing report → verify: everything green; report records scan, move-rate, and pipeline timings  (footprint: none)

## Risk Notes
None — no new trust boundary. Existing exposure (page-injected script in background.js, chrome.storage.local, downloads) is modified behavior-preservingly only; no new permissions, no new data flows, no new surfaces. T3's settle constant is a tuning risk with a one-line revert, verified by the alignment harness (not a trust boundary).

## Quality Contract
1. No new deps, no build step; every touched JS passes the strict-.mjs CI syntax gate.
2. Behavior preservation is the contract: golden-pixel equivalence, hidden-set equivalence, feature-matrix regression — all harnessed, not eyeballed.
3. Perf is evidenced, not asserted: structural counters (drawImage/getContext/hidden-scan) + before/after timings recorded in the report.
4. Memory bounded: decode concurrency ≤ 4; no new full-resolution canvas allocations beyond the layer split.
5. No permission/manifest/data-format changes; feature UI untouched.

## Loop Budget
Re-verify cycles: 2

## Revisions
## [2026-08-11] Rev 1: New scope — performance optimization. Previous plan (5 features + storage fix, T1–T7) fully completed and verified; archived in git (1374ae7) and progress.md Archived section. Builder baselines FIRST (T0) before any code change — the refactor rule "tests pass before and after" is the contract for behavior preservation.

### Tasks (current)
T0. Baseline harnesses (no code change) — headless-Chrome pixel/behavior harness (scripted annotation session → canvas composite golden), scan equivalence+timing harness (old scan copy vs new), move-path instrumentation harness (drawImage/getContext counters), mock-chrome capture pipeline harness → verify: all four green on current code; golden + timings recorded for later diff  (footprint: none)
T1. Optimize fixed-element scan (background.js): single forced style recalc + live getElementsByTagName collection reading only style.position; hide/restore semantics verbatim → verify: hidden-node sets identical old-vs-new on synthetic pages (inline-fixed, stylesheet-fixed, sticky, nested); new scan faster with timing recorded  (footprint: hot-path)
T2. Bounded tile decode/stitch (background.js): 4-worker pool + bitmap.close() after each draw → verify: mock-chrome harness asserts max concurrent decodes ≤ 4 and every bitmap closed before resolve; stitched pixels identical to sequential reference  (footprint: hot-path)
T3. Scroll-settle 200→120 ms (background.js SCROLL_SETTLE_MS) → verify: stitch-alignment harness on synthetic tall page — each distinct row captured exactly once, no duplicate/skipped/torn rows; full capture pipeline harness green  (footprint: hot-path)
T4. Editor photo-layer split (editor.html/css/js): stacked editorPhoto img under canvas, redraw() drops photo draw, renderComposite() for download/copy → verify: scripted session (rect/arrow/text, select-move, resize, undo/redo, delete, duplicate, zoom-in) composite pixels identical to T0 golden; download/copy produce matching pixels; move-path harness green  (footprint: hot-path)
T5. Remove willReadFrequently + text-width cache (editor.js): context hint removed; measureText results cached keyed by value+fontSize → verify: getContext-hint recorder shows no hint; multi-annotation text select/move identical to golden; no getImageData anywhere in editor.js  (footprint: hot-path)
T6. Consolidation — re-run all harnesses + full feature regression (capture modes, element picker, delay countdown, shortcuts wiring, CI syntax gate) + final before/after timing report → verify: everything green; report records scan, move-rate, and pipeline timings  (footprint: none)

## Reflection
[2026-08-11] Pass (1 quality note) — the plan's core delivery held: editor move path ~675x faster on large captures (drawImage/move 1→0), stitch memory bounded (concurrency 9→4, bitmaps 1/9→9/9 closed), capture settle 200→120ms, exports bit-identical (11/11 golden steps), all other ACs met. One criterion partially met: R1's "scan measurably faster" — the fixed-element scan refactor is equivalence-verified (1600/1600 hidden set) but within timing noise on the synthetic page (median 42.0 vs 46.0ms); the honest record says no measurable synthetic win, and per-node getComputedStyle is irreducible without changing semantics. User decision: keep the (cleaner, equivalence-verified) scan or revert T1; no correctness or perf regression either way.
