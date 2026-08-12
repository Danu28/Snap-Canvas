// Move-burst micro-bench on a LARGE capture (the real perf problem): draws one
// rect, then times 200 in-page synthetic drag moves. Reports page-side editor
// work (ms) and drawImage counter delta. Run against old (git stash) and new
// code to get the before/after.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./lib/server.mjs";
import { launchChrome, stopChrome, findPageTarget, CDP, addInitScript } from "./lib/cdp.mjs";
import { makeTestImage, pngToDataUrl } from "./lib/png.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const W = Number(process.env.PAGESNAP_W || 2400);
const H = Number(process.env.PAGESNAP_H || 3600);
const { png } = makeTestImage(W, H);
const DATA_URL = pngToDataUrl(png);

const server = await startServer(REPO_ROOT, 8749);
const { proc, userDataDir } = launchChrome({ port: 9235 });
const page = await findPageTarget(9235, "about:blank");
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
await addInitScript(cdp, `
  window.chrome = { storage: { local: { get: async () => ({ latestCapture: { dataUrl: ${JSON.stringify(DATA_URL)}, mode: "full", capturedAt: "x" } }) } }, runtime: { getManifest: () => ({ version: "1.4.0" }) } };
  window.__counters = { drawImage: 0 };
  const pDI = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...a) { window.__counters.drawImage++; return pDI.apply(this, a); };
`);
try {
  await cdp.navigate(`http://127.0.0.1:8749/editor.html`);
  await cdp.sleep(2000);
  const geo = await cdp.evalJs(`(() => {
    const cv = document.getElementById("editorCanvas");
    const cr = cv.getBoundingClientRect();
    const b = [...document.querySelectorAll(".tool-button")].find((x) => x.dataset.tool === "rectangle");
    const br = b.getBoundingClientRect();
    const sel = [...document.querySelectorAll(".tool-button")].find((x) => x.dataset.tool === "select");
    const sr = sel.getBoundingClientRect();
    const sw = document.querySelector('.color-swatch[data-color="#e53935"]').getBoundingClientRect();
    return { rect: { left: cr.left, top: cr.top, width: cr.width, height: cr.height }, rectTool: { x: br.left + br.width / 2, y: br.top + br.height / 2 }, selTool: { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 }, sw: { x: sw.left + sw.width / 2, y: sw.top + sw.height / 2 } };
  })()`);
  const sx = (cx) => geo.rect.left + (cx / W) * geo.rect.width;
  const sy = (cy) => geo.rect.top + (cy / H) * geo.rect.height;
  await cdp.click(geo.sw.x, geo.sw.y);
  await cdp.click(geo.rectTool.x, geo.rectTool.y);
  await cdp.drag(sx(0.10 * W), sy(0.10 * H), sx(0.50 * W), sy(0.50 * H));
  await cdp.click(geo.selTool.x, geo.selTool.y);
  const mid = { x: sx(0.30 * W), y: sy(0.30 * H) };
  await cdp.click(mid.x, mid.y);
  const before = await cdp.evalJs(`window.__counters.drawImage`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: mid.x, y: mid.y, button: "left", buttons: 1, clickCount: 1 });
  const burst = await cdp.evalJs(`(() => {
    const cv = document.getElementById("editorCanvas");
    const mk = (x, y) => new PointerEvent("pointermove", { clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true, buttons: 1 });
    const x0 = ${mid.x}, y0 = ${mid.y};
    const t0 = performance.now();
    for (let i = 1; i <= 200; i++) cv.dispatchEvent(mk(x0 + i, y0 + i));
    return performance.now() - t0;
  })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mid.x + 200, y: mid.y + 200, button: "left", buttons: 0, clickCount: 1 });
  await cdp.sleep(100);
  const after = await cdp.evalJs(`window.__counters.drawImage`);
  const errs = cdp.runtimeErrors().length;
  console.log(JSON.stringify({ canvas: [W, H], pageMoveMs200: Number(burst.toFixed(2)), drawImageDelta: after - before, runtimeErrors: errs }));
  process.exit(0);
} catch (e) { console.log("ERR " + e.message); process.exit(1); }
finally { cdp.close(); stopChrome({ proc, userDataDir }); server.close(); }
