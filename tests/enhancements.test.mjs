// Tests for the suggestion.html enhancement batch (tasks 1–12).
// Static-source assertions in the same style as bug-report.test.mjs, plus real
// behavioral assertions for the shared filename builder (imported, not grepped).
// Run: node --test tests/enhancements.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildFilenameFrom, sanitize, DEFAULT_TEMPLATE } from "../shared.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const bgSrc = read("background.js");
const editorSrc = read("editor.js");
const popupSrc = read("popup.js");
const popupHtml = read("popup.html");
const editorHtml = read("editor.html");

function fn(src, name) {
  const decl = src.indexOf(`function ${name}`);
  assert.ok(decl !== -1, `function ${name} not found`);
  const parenStart = src.indexOf("(", decl);
  let pdepth = 0, p = parenStart;
  for (; p < src.length; p++) {
    if (src[p] === "(") pdepth++;
    else if (src[p] === ")") { pdepth--; if (pdepth === 0) break; }
  }
  const bodyStart = src.indexOf("{", p);
  let bdepth = 0, j = bodyStart;
  for (; j < src.length; j++) {
    if (src[j] === "{") bdepth++;
    else if (src[j] === "}") { bdepth--; if (bdepth === 0) break; }
  }
  return src.slice(bodyStart, j + 1);
}

// --- Task 1: errors surfaced, not swallowed ---
test("capture failures are recorded and badged (Task 1)", () => {
  assert.ok(bgSrc.includes("async function setLastError"), "setLastError missing");
  assert.ok(bgSrc.includes("action.setBadgeText"), "badge not set on error");
  assert.ok(fn(bgSrc, "handleCapture").includes("setLastError"), "handleCapture must record failures");
  assert.ok(popupSrc.includes("lastCaptureError"), "popup must read the stored error");
});

// --- Task 2: IDB fallback for oversized captures ---
test("oversized captures fall back to IndexedDB (Task 2)", () => {
  const f = fn(bgSrc, "storeCaptureAndOpenEditor");
  assert.ok(f.includes("idbPut"), "must persist via IndexedDB on quota failure");
  assert.ok(/QUOTA|quota/.test(f), "must detect a quota error");
  assert.ok(editorSrc.includes("getCaptureDataUrl"), "editor must resolve idb-backed captures");
});

// --- Task 3: annotation auto-save ---
test("annotations auto-save and restore (Task 3)", () => {
  assert.ok(editorSrc.includes("AUTO_SAVE_KEY"), "auto-save key missing");
  assert.ok(fn(editorSrc, "commitHistory").includes("scheduleAutoSave"), "commitHistory must schedule a save");
  assert.ok(editorSrc.includes("restoreAutoSave()"), "restore must be invoked at init");
});

// --- Task 4: sticky-header opt-out ---
test("sticky header is optional (Task 4)", () => {
  assert.ok(popupHtml.includes('id="includeSticky"'), "popup checkbox missing");
  const f = fn(bgSrc, "captureFullPage");
  assert.ok(f.includes("includeSticky"), "captureFullPage must accept the opt-out");
  assert.ok(/isSticky\s*&&\s*!includeStickyFlag/.test(f), "sticky must be kept when opted in (fixed still hidden)");
});

// --- Task 5: crop to selection ---
test("crop to selection shifts annotations and is undoable (Task 5)", () => {
  const f = fn(editorSrc, "cropToSelection");
  assert.ok(f.includes("OffscreenCanvas"), "crop must re-render the image");
  assert.ok(f.includes("x: a.x - rx"), "annotations inside the crop must shift");
  assert.ok(f.includes("historyStack.push"), "crop must be undoable");
  assert.ok(editorHtml.includes('id="cropButton"'), "crop button missing from editor.html");
});

// --- Task 6: tool accelerators ---
test("single-key tool accelerators exist (Task 6)", () => {
  const f = fn(editorSrc, "onKeyDown");
  assert.ok(/r:\s*"rectangle"/.test(f), "R accelerator missing");
  assert.ok(f.includes('key==="0"'), "0 = fit accelerator missing");
  assert.ok(f.includes("setActiveTool"), "accelerators must go through setActiveTool");
});

// --- Task 7: tile accel + early-out ---
test("image wait early-outs and settle is tightened (Task 7)", () => {
  assert.ok(bgSrc.includes("SCROLL_SETTLE_MS = 60"), "scroll settle should be 60ms");
  const f = fn(bgSrc, "waitForViewportImages");
  assert.ok(f.includes("getElementsByTagName(\"img\").length"), "must count images before polling");
  assert.ok(/count === 0\) return/.test(f), "must early-out when the page has no images");
});

// --- Task 8: grouped nudges ---
test("burst nudges collapse into one undo entry (Task 8)", () => {
  const f = fn(editorSrc, "onKeyDown");
  assert.ok(f.includes("nudgeGrouping"), "nudge grouping state missing");
  assert.ok(f.includes("commitNudgeGroup"), "grouped commit missing");
  assert.ok(!f.includes("commitHistory(); setStatus(`Nudged"), "must not commit per keypress");
});

// --- Task 9: filename preview agreed between popup and editor ---
test("popup preview and editor download share one filename builder (Task 9)", () => {
  assert.ok(popupSrc.includes("buildFilenameFrom"), "popup must preview via shared builder");
  assert.ok(editorSrc.includes("buildFilenameFrom"), "editor must download via shared builder");
  assert.ok(editorHtml.includes('id="filenamePreview"'), "editor preview line missing");
});

// --- Task 11: a11y ---
test("a11y: aria-pressed tools, focus trap, keyboard history (Task 11)", () => {
  assert.ok(editorSrc.includes("function trapFocus"), "focus trap missing");
  assert.ok(editorSrc.includes('setAttribute("aria-pressed"'), "aria-pressed not maintained");
  assert.ok(/aria-pressed="true"/.test(editorHtml), "initial aria-pressed missing");
  assert.ok(popupSrc.includes('e.key==="Enter"'), "history items must open via keyboard");
});

// --- Task 12: BUGS.md retired, tests are the source of truth ---
test("BUGS.md is marked retired (Task 12)", () => {
  const bugs = read("BUGS.md");
  assert.ok(/Retired/i.test(bugs), "BUGS.md must be marked retired");
  assert.ok(!/Each bug is evidenced by .* fails, proving the defect/.test(bugs), "stale 'fails' claim must be gone");
});

// --- Real behavior: the shared filename builder ---
test("buildFilenameFrom: substitution, clamping, fallbacks", () => {
  assert.equal(buildFilenameFrom(DEFAULT_TEMPLATE, { domain: "Example.COM", mode: "full" }, new Date("2026-01-02T12:00:00")), "pagesnap-Example-COM-2026-01-02-full.png");
  assert.equal(buildFilenameFrom("{domain}!!", { domain: "a b" }), "a-b.png");
  assert.equal(buildFilenameFrom("   ", { domain: "x" }).startsWith("pagesnap-x-"), true, "blank template falls back to the default");
  assert.equal(buildFilenameFrom("{domain}", { domain: "<script>alert(1)</script>" }), "script-alert-1-script.png");
  assert.equal(buildFilenameFrom("shot", {}), "shot.png");
  assert.equal(buildFilenameFrom("shot.png", {}), "shot.png", "must not double the extension");
  assert.equal(sanitize(""), "page");
});
