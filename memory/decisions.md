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
