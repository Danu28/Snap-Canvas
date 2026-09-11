---
name: brain-edit-unique-oldtext-context
description: An edit{} oldText is short/repetitive (e.g. `if (x) { return; }`) and the tool reports "Found N occurrences" or "Could n
---

# edit-unique-oldtext-context

1. Do NOT retry the same short oldText.\n2. Extend oldText upward until it includes a line unique to the intended site (a preceding distinct branch, a named function signature, or the sibling key like `releasePointerCapture`).\n3. If the file was edited earlier in the same session, re-read that region first — prior edits may have collapsed blank lines so your remembered text no longer matches whitespace.\n4. For sibling blocks (onKeyDown vs onKeyUp), anchor on the unique neighbour call (e.g. `duplicateSelected();`) rather than the shared body.

## Alternative (mutate)

Alternative: replace the whole enclosing function via a single edit whose oldText is the full function body (find it with `sed -n '/^function name/,/^}/p'`) — unambiguous by construction, and lets you restructure in one shot instead of N fragile micro-edits.

