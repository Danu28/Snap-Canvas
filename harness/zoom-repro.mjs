// Zoom repro — drive the REAL editor.html at browser zoom levels
// (Emulation.setDeviceMetricsOverride + Emulation.setPageScaleFactor) and
// check geometry + pointer accuracy + photo/canvas alignment at each zoom.
// Writes zoom-report.json and screenshots per zoom.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./lib/server.mjs";
import { launchChrome, stopChrome, findPageTarget, CDP, addInitScript } from "./lib/cdp.mjs";
import { makeTestImage, pngToDataUrl } from "./lib/png.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const HTTP_PORT = 8743;
const CDP_PORT = 9231;
const OUT = process.argv[2] || join(__dirname, "zoom-report.json");

const ZOOMS = [0.8, 1.0, 1.25];
const { width: IMG_W, height: IMG_H, png } = makeTestImage();
const IMG_DATA_URL = pngToDataUrl(png);

const server = await startServer(REPO_ROOT, HTTP_PORT);
const { proc, userDataDir } = launchChrome({ port: CDP_PORT, windowSize: "1200,800" });
const page = await findPageTarget(CDP_PORT, "about:blank");
const cdp = await CDP.connect(page.webSocketDebuggerUrl);

const init = `
  window.chrome = {
    storage: { local: { get: async () => ({ latestCapture: { dataUrl: ${JSON.stringify(IMG_DATA_URL)}, mode: "full", capturedAt: "2026-08-11T00:00:00.000Z" } }) } },
    runtime: { getManifest: () => ({ version: "1.4.0" }) }
  };
  window.__pageErrors = [];
  window.addEventListener("error", (e) => window.__pageErrors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__pageErrors.push("unhandledrejection: " + String(e.reason)));
  // Capture every rect drawn via strokeRect (buffer-space coords). The last
  // one after a drag commit = the committed annotation rect.
  const pSR = CanvasRenderingContext2D.prototype.strokeRect;
  window.__strokeRects = [];
  CanvasRenderingContext2D.prototype.strokeRect = function (...a) { window.__strokeRects.push([...a]); return pSR.apply(this, a); };
`;
await addInitScript(cdp, init);

const report = { zooms: [] };

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  for (const zoom of ZOOMS) {
    const entry = { zoom };
    // Emulate REAL browser zoom faithfully: Chrome's zoom scales the CSS
    // viewport (innerWidth = device/z) and multiplies devicePixelRatio (dpr = z).
    // (setPageScaleFactor is pinch-zoom semantics — innerWidth constant — and
    // does NOT match Ctrl+/- zoom, so it is not used here.)
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: Math.round(1200 / zoom), height: Math.round(800 / zoom),
      deviceScaleFactor: zoom, mobile: false
    });

    await cdp.navigate(`http://127.0.0.1:${HTTP_PORT}/editor.html`);
    for (let i = 0; i < 80; i += 1) {
      const status = await cdp.evalJs(`document.getElementById("editorStatus").textContent`);
      if (String(status).includes("Ready")) break;
      await cdp.sleep(200);
    }
    entry.status = await cdp.evalJs(`document.getElementById("editorStatus").textContent`);

    // Geometry: CSS layout values + element boxes.
    entry.geo = await cdp.evalJs(`(() => {
      const cv = document.getElementById("editorCanvas");
      const img = document.getElementById("editorPhoto");
      const stack = document.querySelector(".canvas-stack");
      const area = document.querySelector(".canvas-area");
      const cr = cv.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      const sr = stack.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        areaClientWidth: area.clientWidth, areaScrollWidth: area.scrollWidth,
        fitLabel: document.getElementById("zoomLabel").textContent,
        canvasCss: { w: cv.style.width, h: cv.style.height },
        canvasBuf: { w: cv.width, h: cv.height },
        rect: { left: cr.left, top: cr.top, width: cr.width, height: cr.height },
        photoRect: { left: ir.left, top: ir.top, width: ir.width, height: ir.height },
        stackRect: { left: sr.left, top: sr.top, width: sr.width, height: sr.height },
        stackOverflowX: area.scrollWidth - area.clientWidth,
        stackOverflowY: area.scrollHeight - area.clientHeight
      };
    })()`);

    const g = entry.geo;

    // Scroll the canvas into view before dragging (single-column layout at
    // ≤960px puts the canvas below the fold; real users scroll there).
    await cdp.evalJs(`document.querySelector(".canvas-wrap").scrollIntoView({ block: "center" })`);
    await cdp.sleep(150);
    const crAfter = await cdp.evalJs(`(() => { const r = document.getElementById("editorCanvas").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    entry.alignment = {
      photoVsCanvasDelta: {
        left: +(g.photoRect.left - g.rect.left).toFixed(3),
        top: +(g.photoRect.top - g.rect.top).toFixed(3),
        width: +(g.photoRect.width - g.rect.width).toFixed(3),
        height: +(g.photoRect.height - g.rect.height).toFixed(3)
      },
      photoVsCanvasAbs: {
        dx: +Math.abs(g.photoRect.left - g.rect.left).toFixed(3),
        dy: +Math.abs(g.photoRect.top - g.rect.top).toFixed(3),
        dw: +Math.abs(g.photoRect.width - g.rect.width).toFixed(3),
        dh: +Math.abs(g.photoRect.height - g.rect.height).toFixed(3)
      }
    };

    // Pointer accuracy: click-drag a rectangle across the CANVAS at CSS points
    // and verify the annotation lands at the expected buffer coords.
    // Canvas rect is in CSS px; Input.dispatchMouseEvent coords are in DEVICE
    // px when a page scale is applied — calibrate empirically.
    const cr = crAfter;
    // CSS-space target points inside the canvas (fraction of image):
    const cssA = { x: cr.left + cr.width * 0.2, y: cr.top + cr.height * 0.2 };
    const cssB = { x: cr.left + cr.width * 0.6, y: cr.top + cr.height * 0.5 };
    const devA = { x: cssA.x, y: cssA.y };
    const devB = { x: cssB.x, y: cssB.y };
    await cdp.drag(devA.x, devA.y, devB.x, devB.y);
    const strokes = await cdp.evalJs(`window.__strokeRects`);
    entry.strokeRects = strokes;
    const exp = {
      x: +(IMG_W * 0.2).toFixed(2), y: +(IMG_H * 0.2).toFixed(2),
      width: +(IMG_W * 0.4).toFixed(2), height: +(IMG_H * 0.3).toFixed(2)
    };
    const last = strokes.length ? strokes[strokes.length - 1] : null;
    if (last) {
      entry.pointerAccuracy = {
        expected: exp,
        actual: { x: +last[0].toFixed(2), y: +last[1].toFixed(2), width: +last[2].toFixed(2), height: +last[3].toFixed(2) },
        dx: +(last[0] - exp.x).toFixed(2), dy: +(last[1] - exp.y).toFixed(2),
        dw: +(last[2] - exp.width).toFixed(2), dh: +(last[3] - exp.height).toFixed(2)
      };
    } else {
      entry.pointerAccuracy = { note: "no strokeRect recorded — drag missed the canvas", cssA, cssB, devA, devB };
    }

    // Reset: clear via undo if anything was drawn.
    if (last) {
      await cdp.key("z", 2);
    }

    entry.pageErrors = await cdp.evalJs(`window.__pageErrors`);
    // Screenshot for eyeballing.
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(__dirname, `zoom-${String(zoom).replace(".", "_")}.png`), Buffer.from(shot.data, "base64"));
    report.zooms.push(entry);
    console.log(`zoom ${zoom}: innerWidth=${g.innerWidth} dpr=${g.dpr} fit=${g.fitLabel} photo/canvasΔ=(${entry.alignment.photoVsCanvasAbs.dx},${entry.alignment.photoVsCanvasAbs.dy},${entry.alignment.photoVsCanvasAbs.dw},${entry.alignment.photoVsCanvasAbs.dh}) strokes=${strokes.length} errs=${entry.pageErrors.length}`);
  }
} finally {
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log("saved:", OUT);
  cdp.close();
  stopChrome({ proc, userDataDir });
  server.close();
}
