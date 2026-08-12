## [2026-08-11] Decision: Harden handler + verify stamp instead of minimal relax

Context: `/brainstorm` extension produced a spurious `Error: Usage: ...` mid-
flow (mode was ON but an input hit the default branch), and there was no way
to tell whether the temperature/top_p stamp actually reached provider
requests.

Options:
- A: Harden arg resolution (prefix + alias matching, help, received-args echo)
  AND capture the last-stamped payload in `before_provider_request`, surfaced
  in `/brainstorm status`. One file. No deps.
- B: Only relax the handler (prefix matching). Cheaper but leaves "does the
  stamp actually apply?" unanswerable.
- C: Per-request options injection via provider config. Invasive; pi exposes
  no cleaner hook than `before_provider_request`.

Chosen: A — fixes the error class AND gives real evidence the hook fires;
cost is ~30 lines in one extension file.

Consequences: status output gains a "✓ last request stamped … (HH:MM:SS)"
line; unknown inputs show `(received: '<args>')` for diagnosability. No
change to sampling values (0.8 / 0.95) or the `/skill:brainstormer` auto-
enable behavior.

## [2026-08-11] Decision: Perf scope — editor photo-layer split + bounded stitch + scan/settle tuning

Context: user asked to "improve this browser extension for better performance. Make sure features not affected or degraded." Hot paths identified: (a) full-page capture fixed-element scan does getComputedStyle on every node; (b) stitchTiles decodes ALL tiles concurrently (unbounded memory); (c) editor redraw() re-draws the whole photo + every annotation on EVERY pointermove; (d) willReadFrequently:true forces CPU canvas with no getImageData usage.

Options (per hot spot):
- Editor redraw: A) stacked <img> photo layer under the canvas (photo drawn once by the browser, canvas holds only annotations; renderComposite() for download/copy) vs B) dirty-region restore from an OffscreenCanvas copy (no DOM change, but bbox/overlap math + ghosting risk) vs C) rAF-throttle redraws only (doesn't fix the per-redraw cost). Chosen: A — zero region math, zero ghosting risk, memory unchanged (canvas same size; photo reused via img), export trivially verifiable pixel-identical. Rejected B (subtle artifact risk on overlap), C (band-aid).
- Stitch memory: bounded worker pool (CONCURRENCY=4) with bitmap.close() after draw vs Promise.all (unbounded peak). Chosen: pool — disjoint draw regions make order irrelevant; peak = 4 tiles + output.
- Fixed scan: single forced recalc + live HTMLCollection + read only style.position vs stylesheet-probe shortcuts (rejected: correctness risk missing fixed elements = stitch duplication).
- Scroll settle: 200→120 ms, one-line revert if seams appear, alignment harness verifies.
- willReadFrequently: removed — no getImageData anywhere; GPU canvas accelerates the now vector-only redraws.

Consequences: all changes behavior-preserving by design; pixel-equivalence + hidden-set harnesses (T0 baselines recorded BEFORE code change) are the regression contract. Gate 2 not triggered (no boundary task, Risk Notes = None — existing exposure modified behavior-preservingly, no new surface). Verifier tier Full.

## [2026-08-11] Decision: Adopt memory/ for SnapCanvas + feature set for this build

Context: the five memory files in this repo held notes for a different project (a pi
`/brainstorm` extension). The current plan (plan.md) is now SnapCanvas's: implement the 5
ranked brainstorm ideas + the storage quota bug fix.

Options (per feature, chosen design in plan.md D1–D6):
- Zoom: CSS display-size scaling (buffer untouched, getCanvasPoint stays correct) vs
  buffer re-render or ctx.scale (rejected: blurry/thick strokes, coordinate churn).
- Element capture: context-menu + dedicated element-picker.js reusing handleSelectedCapture
  vs popup button mode (cut — one surface, not two).
- Inline text: overlay <textarea> vs in-canvas caret/IME editor (rejected: complexity).
- Delayed capture: background-owned timer with popup countdown display vs chrome.notifications
  (rejected: extra permission). Delay applies to full/visible only; shortcuts stay instant.
- Gate 1 (reviewer) retained R1–R6; revised R3 wording (viewport-space crop, overlay
  limitation documented); cut popup button for element capture; "duplicate" flagged
  cuttable-but-kept (cheap, requested).

Chosen: feature set + designs per plan.md. Consequence: all tasks are plain JS, no deps,
no build step; T1 (unlimitedStorage) and T3 (contextMenus + element-picker.js injection)
are tagged `boundary` → Gate 2 reviewer runs after plan approval.
