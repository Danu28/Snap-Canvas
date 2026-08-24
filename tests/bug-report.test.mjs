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
  const decl = src.indexOf(`function ${name}`);
  assert.ok(decl !== -1, `function ${name} not found`);
  // Skip past the parameter list (handles destructured params like ({ rect }))
  // so we find the function body's opening brace, not a param brace.
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

test("full-page stitch does not paint transparent regions black (B6)", () => {
  const f = fn(bgSrc, "stitchTiles");
  assert.ok(
    !f.includes("alpha: false"),
    "stitchTiles must not use an opaque (alpha:false) canvas that turns transparent page regions black"
  );
});
