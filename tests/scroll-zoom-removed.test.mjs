// Verifies the scroll-wheel zoom feature is removed from the editor while the
// zoom buttons remain. Run: node --test tests/scroll-zoom-removed.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const editorSrc = readFileSync(join(root, "editor.js"), "utf8");

test("scroll-wheel zoom is removed", () => {
  assert.ok(
    !editorSrc.includes('addEventListener("wheel"'),
    "bindEvents must not register a wheel listener"
  );
  assert.ok(
    !editorSrc.includes("function onWheel"),
    "the onWheel (scroll zoom) function must be removed"
  );
});

test("zoom buttons retained", () => {
  assert.ok(editorSrc.includes("zoomInButton.addEventListener"), "zoom-in button must remain");
  assert.ok(editorSrc.includes("zoomOutButton.addEventListener"), "zoom-out button must remain");
  assert.ok(editorSrc.includes("fitButton.addEventListener"), "fit button must remain");
});
