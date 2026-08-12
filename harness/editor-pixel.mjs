// H1 — Editor pixel-equivalence + move-path harness.
// Real CDP input drives a scripted annotation session on the REAL editor.html;
// after each step the composite (photo layer + annotation canvas) is hashed.
// T0 records golden-editor.json; T4 re-runs and must reproduce identical hashes.
// Also: drawImage/getImageData/getContext counters + move-burst timing.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./lib/server.mjs";
import { launchChrome, stopChrome, findPageTarget, CDP, addInitScript } from "./lib/cdp.mjs";
import { makeTestImage, pngToDataUrl } from "./lib/png.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const HTTP_PORT = 8737;
const CDP_PORT = 9223;
const OUT = process.argv[2] || join(__dirname, "golden-editor.json");
// Optional: compare against a previously recorded golden instead of recording.
const GOLDEN = process.argv[3];

const { width: IMG_W, height: IMG_H, png } = makeTestImage();
const IMG_DATA_URL = pngToDataUrl(png);

const server = await startServer(REPO_ROOT, HTTP_PORT);
const { proc, userDataDir } = launchChrome({ port: CDP_PORT });
const page = await findPageTarget(CDP_PORT, "about:blank");
const cdp = await CDP.connect(page.webSocketDebuggerUrl);

const log = [];
const stepHashes = [];

await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

// Init scripts: chrome stub + counters + composite reader + error collector.
// Runs before editor.js so the stub and prototype patches are in place.
const init = `
  window.chrome = {
    storage: { local: { get: async () => ({ latestCapture: { dataUrl: ${JSON.stringify(IMG_DATA_URL)}, mode: "full", capturedAt: "2026-08-11T00:00:00.000Z" } }) } },
    runtime: { getManifest: () => ({ version: "1.4.0" }) }
  };
  window.__counters = { drawImage: 0, getImageData: 0, getContextHints: [] };
  const pDI = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) { window.__counters.drawImage++; return pDI.apply(this, a); };
  const pGID = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...a) { window.__counters.getImageData++; return pGID.apply(this, a); };
  const pGC = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...a) { window.__counters.getContextHints.push(a[1] ? JSON.stringify(a[1]) : null); return pGC.apply(this, a); };
  window.__pageErrors = [];
  window.addEventListener("error", (e) => window.__pageErrors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__pageErrors.push("unhandledrejection: " + String(e.reason)));
  // Capture the real download artifact: the export path (renderComposite in new
  // code, canvas.toDataURL in old) is exactly what downloadImage ships. The
  // anchor is detached, so intercept at the prototype level.
  window.__lastDownloadHref = null;
  const origAClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) window.__lastDownloadHref = this.href;
    return origAClick.call(this);
  };
  const hashUrl = (url) => { let h = 0; for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0; return h >>> 0; };
  window.__downloadHash = async () => {
    document.getElementById("downloadButton").click();
    await new Promise((r) => setTimeout(r, 60));
    return hashUrl(window.__lastDownloadHref || "");
  };
  // Display-path composite (photo layer + annotation canvas) — informational
  // only; the display is expected to differ by <=1 channel at AA edges (inherent
  // to two-layer compositing), the export path must be bit-identical.
  window.__moveTimes = [];
  window.addEventListener("pointermove", () => window.__moveTimes.push(performance.now()), true);
  window.__snapCompositeHash = async () => {
    const cv = document.querySelector("#editorCanvas");
    const img = document.querySelector("#editorPhoto");
    const scratch = document.createElement("canvas");
    scratch.width = cv.width; scratch.height = cv.height;
    const ctx = scratch.getContext("2d");
    if (img) { await img.decode(); ctx.drawImage(img, 0, 0); }
    ctx.drawImage(cv, 0, 0);
    return hashUrl(scratch.toDataURL("image/png"));
  };
`;
await addInitScript(cdp, init);

try {
  await cdp.navigate(`http://127.0.0.1:${HTTP_PORT}/editor.html`);

  // Wait for the editor to be ready.
  for (let i = 0; i < 80; i += 1) {
    const status = await cdp.evalJs(`document.getElementById("editorStatus").textContent`);
    if (String(status).includes("Ready")) break;
    await cdp.sleep(200);
  }
  log.push("status: " + (await cdp.evalJs(`document.getElementById("editorStatus").textContent`)));

  const geo = await cdp.evalJs(`(() => {
    const cv = document.getElementById("editorCanvas");
    const cr = cv.getBoundingClientRect();
    const tool = {};
    for (const t of ["rectangle", "arrow", "text", "select"]) {
      const b = [...document.querySelectorAll(".tool-button")].find((x) => x.dataset.tool === t);
      const r = b.getBoundingClientRect();
      tool[t] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const sw = document.querySelector('.color-swatch[data-color="#e53935"]').getBoundingClientRect();
    const zoomIn = document.getElementById("zoomInButton").getBoundingClientRect();
    const undoB = document.getElementById("undoButton").getBoundingClientRect();
    const redoB = document.getElementById("redoButton").getBoundingClientRect();
    return {
      rect: { left: cr.left, top: cr.top, width: cr.width, height: cr.height },
      ratioX: ${IMG_W} / cr.width, ratioY: ${IMG_H} / cr.height,
      tool, sw: { x: sw.left + sw.width / 2, y: sw.top + sw.height / 2 },
      zoomIn: { x: zoomIn.left + zoomIn.width / 2, y: zoomIn.top + zoomIn.height / 2 },
      undoB: { x: undoB.left + undoB.width / 2, y: undoB.top + undoB.height / 2 },
      redoB: { x: redoB.left + redoB.width / 2, y: redoB.top + redoB.height / 2 }
    };
  })()`);

  // canvas-space → screen
  const sx = (cx) => geo.rect.left + (cx / IMG_W) * geo.rect.width;
  const sy = (cy) => geo.rect.top + (cy / IMG_H) * geo.rect.height;

  async function step(name) {
    await cdp.sleep(120);
    const hash = await cdp.evalJs(`window.__downloadHash()`);
    const display = await cdp.evalJs(`window.__snapCompositeHash()`);
    stepHashes.push({ step: name, hash });
    log.push(`step ${name}: download hash ${hash} (display ${display})`);
  }

  // Red swatch for contrast.
  await cdp.click(geo.sw.x, geo.sw.y);

  // 1. Rectangle 35%->60%.
  await cdp.click(geo.tool.rectangle.x, geo.tool.rectangle.y);
  await cdp.drag(sx(0.35 * IMG_W), sy(0.35 * IMG_H), sx(0.60 * IMG_W), sy(0.60 * IMG_H));
  await step("rect");

  // 2. Arrow 20%->45%.
  await cdp.click(geo.tool.arrow.x, geo.tool.arrow.y);
  await cdp.drag(sx(0.20 * IMG_W), sy(0.20 * IMG_H), sx(0.45 * IMG_W), sy(0.45 * IMG_H));
  await step("arrow");

  // 3. Text "Hi" at 40%,40% (real typing + Enter).
  await cdp.click(geo.tool.text.x, geo.tool.text.y);
  await cdp.click(sx(0.40 * IMG_W), sy(0.40 * IMG_H));
  await cdp.typeText("Hi");
  await cdp.key("Enter");
  await step("text");

  // 4. Select tool, click inside rect (440,340 canvas-space — inside the rect,
  //    off the arrow line and off the text bbox), drag +40,+40 client px.
  await cdp.click(geo.tool.select.x, geo.tool.select.y);
  const moveDx = 40 * geo.ratioX, moveDy = 40 * geo.ratioY;
  await cdp.click(sx(440), sy(340));
  await cdp.drag(sx(440), sy(340), sx(440 + 40), sy(340 + 40));
  await step("select-move");

  // 5. Resize: SE handle of the moved rect at (0.60W+moveDx, 0.60H+moveDy), drag +20,+20 client.
  const seX = 0.60 * IMG_W + moveDx, seY = 0.60 * IMG_H + moveDy;
  await cdp.drag(sx(seX), sy(seY), sx(seX + 20), sy(seY + 20));
  await step("resize");

  // 6. Undo, 7. Redo.
  await cdp.click(geo.undoB.x, geo.undoB.y);
  await step("undo");
  await cdp.click(geo.redoB.x, geo.redoB.y);
  await step("redo");

  // 8. Delete: delete the TEXT annotation (click at its position, press Delete) —
  //    the rect must survive for the duplicate step.
  await cdp.click(sx(320), sy(240));
  await cdp.key("Delete");
  await step("delete");

  // 9. Duplicate: select the post-resize rect, Ctrl+D.
  const rx = 0.35 * IMG_W + moveDx, ry = 0.35 * IMG_H + moveDy;
  const rw = 0.25 * IMG_W + 20 * geo.ratioX, rh = 0.25 * IMG_H + 20 * geo.ratioY;
  await cdp.click(sx(rx + rw * 0.6), sy(ry + rh * 0.5));
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "d", code: "KeyD", windowsVirtualKeyCode: 68, modifiers: 2 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "d", code: "KeyD", windowsVirtualKeyCode: 68, modifiers: 2 });
  await cdp.sleep(100);
  await step("duplicate");

  // 10. Zoom in x2 — display-only, composite must be unchanged.
  await cdp.click(geo.zoomIn.x, geo.zoomIn.y);
  await cdp.click(geo.zoomIn.x, geo.zoomIn.y);
  await step("zoom");

  // 11. Move burst: select the duplicate (offset +20 canvas px). Real press
  //     creates the active pointer; the 200 moves are dispatched in-page
  //     (synthetic, pointerId 1) so the timing is pure editor work, not CDP
  //     roundtrip latency. drawImage counter delta is measured across the burst.
  const dup = { x: rx + 20, y: ry + 20, w: rw, h: rh };
  const burstX = sx(dup.x + dup.w * 0.6), burstY = sy(dup.y + dup.h * 0.5);
  await cdp.click(burstX, burstY);
  const before = await cdp.evalJs(`({ di: window.__counters.drawImage, t: Date.now() })`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: burstX, y: burstY, button: "left", buttons: 1, clickCount: 1 });
  const burst = await cdp.evalJs(`(() => {
    const cv = document.getElementById("editorCanvas");
    const mk = (x, y) => new PointerEvent("pointermove", { clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true, buttons: 1 });
    const x0 = ${burstX}, y0 = ${burstY};
    const t0 = performance.now();
    for (let i = 1; i <= 200; i++) cv.dispatchEvent(mk(x0 + i, y0 + i));
    return performance.now() - t0;
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: burstX + 200, y: burstY + 200, button: "left", buttons: 0, clickCount: 1 });
  await cdp.sleep(150);
  const after = await cdp.evalJs(`({ di: window.__counters.drawImage, t: Date.now() })`);
  const drawImageDelta = after.di - before.di;
  const burstMs = after.t - before.t;
  const pageMoveMs = burst;
  log.push(`move burst: drawImage delta=${drawImageDelta}, wall ${burstMs}ms, page-side ${pageMoveMs.toFixed(2)}ms for 200 in-page moves`);
  await step("move-burst");

  const counters = await cdp.evalJs(`window.__counters`);
  const pageErrors = await cdp.evalJs(`window.__pageErrors`);
  const runtimeErrors = cdp.runtimeErrors().length;

  const report = {
    kind: "editor-pixel",
    recordedAt: new Date().toISOString(),
    image: { width: IMG_W, height: IMG_H },
    steps: stepHashes,
    counters,
    moveBurst: { drawImageDelta, burstMs, pageMoveMs },
    pageErrors,
    runtimeErrors
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log.push("saved: " + OUT);
  log.push(`counters: ${JSON.stringify(counters)}`);
  log.push(`pageErrors: ${JSON.stringify(pageErrors)}`);
  log.push(`runtimeErrors: ${runtimeErrors}`);

  const ok = pageErrors.length === 0 && runtimeErrors === 0;
  console.log(log.join("\n"));

  if (GOLDEN) {
    // Comparison mode: every step's export hash must match the golden exactly.
    let reference;
    try {
      reference = JSON.parse(readFileSync(GOLDEN, "utf8"));
    } catch {
      console.log("H1 FAIL (cannot read golden " + GOLDEN + ")");
      process.exit(1);
    }
    const mismatches = [];
    const refSteps = reference.steps || [];
    for (let i = 0; i < stepHashes.length; i++) {
      const ref = refSteps.find((s) => s.step === stepHashes[i].step);
      if (!ref || ref.hash !== stepHashes[i].hash) {
        mismatches.push({ step: stepHashes[i].step, expected: ref?.hash, actual: stepHashes[i].hash });
      }
    }
    if (mismatches.length === 0 && ok) {
      console.log(`H1 PASS (export bit-identical to golden: ${stepHashes.length}/${stepHashes.length} steps)`);
      process.exit(0);
    }
    console.log("H1 FAIL (golden mismatch): " + JSON.stringify(mismatches));
    process.exit(1);
  }

  console.log(ok ? "H1 PASS (baseline recorded)" : "H1 FAIL (errors present)");
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(log.join("\n"));
  console.log("H1 DRIVER ERROR: " + e.message);
  process.exit(1);
} finally {
  cdp.close();
  stopChrome({ proc, userDataDir });
  server.close();
}
