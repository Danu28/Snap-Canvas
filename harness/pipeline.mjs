// H4 — Full-page capture pipeline harness (real code, headless Chrome).
// Loads background.js into a page with a chrome API stub, drives START_CAPTURE
// full-page on a synthetic 12-row tall page, then verifies the stitched result:
//   - every row appears exactly once, in order (stitch + settle correctness)
//   - tile decode concurrency is bounded (T2) and every bitmap closed
//   - storage.write + editor-tab open happen (pipeline wiring)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./lib/server.mjs";
import { launchChrome, stopChrome, findPageTarget, CDP, addInitScript } from "./lib/cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const HTTP_PORT = 8739;
const CDP_PORT = 9225;
const OUT = process.argv[2] || join(__dirname, "pipeline-report.json");

const ROW_H = 300;
const N_ROWS = 12;
const PAGE_H = ROW_H * N_ROWS; // 3600
const ROW_COLORS = Array.from({ length: N_ROWS }, (_, i) => [
  (i * 61) % 256,
  (i * 103) % 256,
  (i * 29) % 256
]);

let pageHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body>`;
for (let r = 0; r < N_ROWS; r++) {
  const [rr, gg, bb] = ROW_COLORS[r];
  pageHtml += `<div style="height:${ROW_H}px;background:rgb(${rr},${gg},${bb})"></div>`;
}
pageHtml += `</body></html>`;
writeFileSync(join(__dirname, "pipeline-page.html"), pageHtml);

const backgroundSrc = readFileSync(join(REPO_ROOT, "background.js"), "utf8");

// In-page chrome stub + instrumentation. Rendered viewport captures are drawn
// from the real row geometry at the CURRENT scroll position — so any torn or
// stale tile shows up as a wrong row sequence in the stitched output.
const init = `
  window.__pipeline = { stored: null, createdTabs: [], visibleCaptureCount: 0 };
  window.__cimb = { now: 0, max: 0, created: 0, closed: 0 };
  const pCIMB = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async function (...args) {
    window.__cimb.now++; window.__cimb.created++;
    window.__cimb.max = Math.max(window.__cimb.max, window.__cimb.now);
    const bmp = await pCIMB.apply(this, args);
    const close = bmp.close.bind(bmp);
    bmp.close = () => { window.__cimb.now--; window.__cimb.closed++; close(); };
    return bmp;
  };

  const ROW_H = ${ROW_H};
  const N_ROWS = ${N_ROWS};
  const ROW_COLORS = ${JSON.stringify(ROW_COLORS)};
  window.__rowAt = (pageY) => {
    const r = Math.floor(pageY / ROW_H);
    if (r < 0 || r >= N_ROWS) return null;
    return ROW_COLORS[r];
  };
  window.__renderViewportDataUrl = async () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const cv = new OffscreenCanvas(vw, vh);
    const ctx = cv.getContext("2d");
    const sy = window.scrollY;
    for (let y = 0; y < vh; y++) {
      const c = window.__rowAt(sy + y);
      if (c) { ctx.fillStyle = \`rgb(\${c[0]},\${c[1]},\${c[2]})\`; ctx.fillRect(0, y, vw, 1); }
    }
    const blob = await cv.convertToBlob({ type: "image/png" });
    const reader = new FileReader();
    return await new Promise((res) => { reader.onloadend = () => res(reader.result); reader.readAsDataURL(blob); });
  };

  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__pipeline.listener = fn; } },
      onInstalled: { addListener: () => {} },
      getURL: (p) => p
    },
    commands: { onCommand: { addListener: () => {} } },
    contextMenus: { removeAll: (cb) => cb && cb(), create: () => {}, onClicked: { addListener: () => {} } },
    tabs: {
      query: async () => [{ id: 1, windowId: 1 }],
      captureVisibleTab: async () => { window.__pipeline.visibleCaptureCount++; return window.__renderViewportDataUrl(); },
      create: async (t) => { window.__pipeline.createdTabs.push(t.url); return { id: 2 }; }
    },
    scripting: {
      executeScript: async ({ target, func, args }) => [{ result: await func.apply(null, args || []) }]
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async (obj) => { window.__pipeline.stored = obj; }
      }
    }
  };
`;

const server = await startServer(REPO_ROOT, HTTP_PORT);
const { proc, userDataDir } = launchChrome({ port: CDP_PORT, windowSize: "1000,600" });
const page = await findPageTarget(CDP_PORT, "about:blank");
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await addInitScript(cdp, init);

const log = [];
try {
  await cdp.navigate(`http://127.0.0.1:${HTTP_PORT}/harness/pipeline-page.html`);
  await cdp.sleep(500);

  const vw = await cdp.evalJs(`window.innerWidth`);
  const vh = await cdp.evalJs(`window.innerHeight`);
  const viewportMultipleOk = vh % ROW_H === 0;
  log.push(`viewport: ${vw}x${vh} (row-multiple ${viewportMultipleOk})`);

  // Load background.js into the page (classic script — it only registers listeners).
  await cdp.evalJs(`new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "/background.js";
    s.onload = res;
    s.onerror = () => rej(new Error("background.js load failed"));
    document.head.appendChild(s);
  })`);
  await cdp.sleep(300);

  const t0 = Date.now();
  const captureResult = await cdp.evalJs(`(async () => {
    const sendResponse = (r) => { window.__pipeline.response = r; };
    window.__pipeline.listener({ type: "START_CAPTURE", mode: "full", tabId: 1, windowId: 1 }, {}, sendResponse);
    for (let i = 0; i < 200 && !window.__pipeline.response; i++) await new Promise((r) => setTimeout(r, 100));
    return window.__pipeline.response || { timedOut: true };
  })()`);
  const wallMs = Date.now() - t0;
  log.push("capture response: " + JSON.stringify(captureResult));

  // Verify the stitched image: decode stored dataUrl, walk rows, check sequence.
  const check = await cdp.evalJs(`(async () => {
    const stored = window.__pipeline.stored;
    if (!stored || !stored.latestCapture) return { ok: false, why: "no stored capture" };
    const { dataUrl, mode } = stored.latestCapture;
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    const w = img.width, h = img.height;
    const rowSeq = [];
    for (let y = 0; y < h; y++) {
      const i = y * w * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      let found = -1;
      for (let ri = 0; ri < ${N_ROWS}; ri++) {
        if (r === ROW_COLORS[ri][0] && g === ROW_COLORS[ri][1] && b === ROW_COLORS[ri][2]) { found = ri; break; }
      }
      rowSeq.push(found);
    }
    // Compress to runs for the report.
    const runs = [];
    for (let y = 0; y < rowSeq.length; y++) {
      const last = runs[runs.length - 1];
      if (last && last.row === rowSeq[y]) last.len++;
      else runs.push({ y, row: rowSeq[y], len: 1 });
    }
    return { ok: true, w, h, runs: runs.slice(0, 60) };
  })()`);
  log.push("stitch check: " + JSON.stringify(check));

  const counters = await cdp.evalJs(`({ cimb: window.__cimb, tabs: window.__pipeline.createdTabs, captures: window.__pipeline.visibleCaptureCount })`);
  log.push("counters: " + JSON.stringify(counters));

  // Assertions:
  // 1. Response ok, editor tab opened.
  const responseOk = captureResult?.ok === true;
  const tabOk = counters.tabs.length === 1 && counters.tabs[0] === "editor.html";
  // 2. Stitch dims = vw x fullHeight (scale 1:1 since stub renders at innerWidth/Height).
  const dimsOk = check?.w === vw && check?.h === PAGE_H;
  // 3. Every row present exactly once, in order, no unknown pixels. The stitch
  //    math is exact for ANY viewport height (scale 1:1, destY = scrollY), so
  //    the run sequence is the ground truth regardless of innerHeight.
  let seqOk = false;
  if (check?.runs) {
    const actual = check.runs.map((run) => ({ row: run.row, len: run.len }));
    const expected = Array.from({ length: N_ROWS }, (_, r) => ({ row: r, len: ROW_H }));
    seqOk = actual.length === expected.length && actual.every((a, i) => a.row === expected[i].row && a.len === expected[i].len);
  }
  const maxConcurrent = counters.cimb.max;
  const closedAll = counters.cimb.closed === counters.cimb.created;
  // NOTE: concurrency bound (<= 4) and bitmap-close are T2 verify items — reported
  // here for every phase but only gated once the plan's T2 lands. Baseline shows
  // max == tile count and closed == 0 (the leak the plan fixes).

  const report = {
    kind: "pipeline",
    recordedAt: new Date().toISOString(),
    viewport: { vw, vh },
    wallMs,
    response: captureResult,
    stitch: check,
    counters,
    assertions: { responseOk, tabOk, dimsOk, seqOk, maxConcurrent, closedAll }
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log.push(`assertions: ${JSON.stringify(report.assertions)}`);
  log.push("saved: " + OUT);

  const ok = responseOk && tabOk && dimsOk && seqOk;
  console.log(log.join("\n"));
  console.log(ok ? "H4 PASS" : "H4 FAIL");
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(log.join("\n"));
  console.log("H4 DRIVER ERROR: " + e.message);
  process.exit(1);
} finally {
  cdp.close();
  stopChrome({ proc, userDataDir });
  server.close();
}
