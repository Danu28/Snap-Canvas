// Bug-existence tests for SnapCanvas.
// These assert the CORRECT (spec) behavior. They fail because the current
// source violates it — that is the point: they prove each listed bug exists.
// Run: node --test tests/bug-report.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const editorSrc = readFileSync(join(root, "editor.js"), "utf8");
const bgSrc = readFileSync(join(root, "background.js"), "utf8");
const pickerSrc = readFileSync(join(root, "element-picker.js"), "utf8");

function fn(src, name) {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start !== -1, `function ${name} not found`);
  // crude brace match
  let depth = 0, i = src.indexOf("{", start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return src.slice(start, end + 1);
}

test("text renders multiple lines (B1)", () => {
  // Documented: "multi-line", Shift+Enter for a new line.
  // Correct impl must split on "\n" and draw each line.
  assert.ok(
    editorSrc.includes('split("\\n")') || editorSrc.includes("split('\n')"),
    "no newline-splitting found in text rendering path"
  );
});

test("export omits selection handles (B2)", () => {
  const f = fn(editorSrc, "renderComposite");
  assert.ok(!f.includes("drawHandles("), "renderComposite must not draw selection handles into the export");
});

test("element capture restores scroll (B3)", () => {
  const f = fn(bgSrc, "handleSelectedCapture");
  // The picker scrolls the page (scrollIntoView); after the capture the
  // background must restore the prior scroll position. It currently does not.
  assert.ok(
    f.includes("scrollTo"),
    "handleSelectedCapture must restore the prior scroll position after an element capture"
  );
});

test("Backspace not bound to delete in body (B4)", () => {
  assert.ok(
    !editorSrc.includes('"Backspace"'),
    "Backspace should not delete a selected annotation from the page body"
  );
});

test("crop guards zero viewport size (B5)", () => {
  const f = fn(bgSrc, "cropSelectedArea");
  assert.ok(
    /viewportWidth\s*===\s*0|viewportWidth\s*\|\||viewportWidth\s*&&\s*viewportWidth/.test(f),
    "cropSelectedArea divides by rect.viewportWidth with no zero guard"
  );
});
