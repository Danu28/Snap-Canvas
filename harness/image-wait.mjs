// H5 — capture quality mechanics harness (real code, headless Chrome).
// Loads background.js into a page with a chrome API stub and drives START_CAPTURE
// full-page on a synthetic page that has:
//   - `html { scroll-behavior: smooth !important }` (real-world smooth-scroll sites)
//   - an <img> placeholder in the first viewport whose src is assigned 300 ms
//     after capture starts (lazy-load simulation)
// Verifies two mechanics:
//   Q1. During capture, scroll-behavior is forced to 'auto' (the guard), so a
//       real-Chrome smooth scroll can't be captured mid-animation (torn seam).
//   Q2. The per-tile viewport-image wait holds the capture until a visible img
//       finishes loading — the stitch contains the loaded image, not a blank
//       placeholder. (Headless can't animate smooth scroll, so Q1 is verified
//       by mechanism; Q2 is verified by observable output.)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { startServer } from "./lib/server.mjs";
import { launchChrome, stopChrome, findPageTarget, CDP, addInitScript } from "./lib/cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
// Unique ports per run: a previous run's Chrome can still be shutting down and
// binding the same CDP port would make us attach to a stale instance.
const HTTP_PORT = 8700 + (process.pid % 200);
const CDP_PORT = 9300 + (process.pid % 200);
const OUT = process.argv[2] || join(__dirname, "image-wait-report.json");

const ROW_H = 300;
const N_ROWS = 2;
const PAGE_H = ROW_H * N_ROWS; // 600
const ROW_COLORS = [[200, 30, 30], [30, 30, 200]];
const IMG = { x: 10, y: 10, w: 120, h: 80, color: [220, 220, 30] }; // yellow box on load

// Tiny valid red PNG (2x2) so the img actually decodes (naturalWidth > 0).
function redPng() {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.from([0, 200, 30, 30, 200, 30, 30, 0, 200, 30, 30, 200, 30, 30]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
writeFileSync(join(__dirname, "img-red.png"), redPng());

let pageHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0}
html{scroll-behavior:smooth!important}
#slowImg{position:absolute;left:${IMG.x}px;top:${IMG.y}px;width:${IMG.w}px;height:${IMG.h}px}
</style></head><body>`;
for (let r = 0; r < N_ROWS; r++) {
  const [rr, gg, bb] = ROW_COLORS[r];
  pageHtml += `<div style="height:${ROW_H}px;background:rgb(${rr},${gg},${bb})"></div>`;
}
pageHtml += `<img id="slowImg" src="/harness/img-red.png" alt="">`;
pageHtml += `</body></html>`;
writeFileSync(join(__dirname, "image-wait-page.html"), pageHtml);

const BG_SRC_URL = process.env.BG_SRC_URL || "/background.js";

const init = `
  window.__pipeline = { stored: null, createdTabs: [], captureCount: 0, behaviors: [] };
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

  const ROW_H = ${ROW_H}, N_ROWS = ${N_ROWS};
  const ROW_COLORS = ${JSON.stringify(ROW_COLORS)};
  const IMG = ${JSON.stringify(IMG)};
  window.__rowAt = (pageY) => {
    const r = Math.floor(pageY / ROW_H);
    if (r < 0 || r >= N_ROWS) return null;
    return ROW_COLORS[r];
  };
  // Simulates the browser compositor: rows from geometry + the img's loaded
  // state at capture time (yellow box once complete, transparent placeholder
  // before). This is what a real capture of the rendered page would show.
  window.__renderViewportDataUrl = async () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const cv = new OffscreenCanvas(vw, vh);
    const ctx = cv.getContext("2d");
    const sy = window.scrollY;
    for (let y = 0; y < vh; y++) {
      const c = window.__rowAt(sy + y);
      if (c) { ctx.fillStyle = \`rgb(\${c[0]},\${c[1]},\${c[2]})\`; ctx.fillRect(0, y, vw, 1); }
    }
    const img = document.getElementById("slowImg");
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.fillStyle = \`rgb(\${IMG.color[0]},\${IMG.color[1]},\${IMG.color[2]})\`;
      ctx.fillRect(IMG.x, IMG.y, IMG.w, IMG.h);
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
      captureVisibleTab: async () => {
        window.__pipeline.captureCount++;
        window.__pipeline.behaviors.push(getComputedStyle(document.documentElement).scrollBehavior);
        return window.__renderViewportDataUrl();
      },
      create: async (t) => { window.__pipeline.createdTabs.push(t.url); return { id: 2 }; }
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        const out = await func.apply(null, args || []);
        const isImageCheck = String(func).includes('getElementsByTagName("img")');
        if (isImageCheck) {
          window.__pipeline.imageChecks = window.__pipeline.imageChecks || [];
          window.__pipeline.imageChecks.push({ t: Date.now(), result: out, imgComplete: (() => { const i = document.getElementById("slowImg"); return i ? i.complete + "/" + i.naturalWidth + "/" + i.src.slice(-20) : "missing"; })() });
        }
        return [{ result: out }];
      }
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
const trace = (msg) => { log.push(msg); console.error(msg); };
trace("H5 start (pid " + process.pid + ", ports " + HTTP_PORT + "/" + CDP_PORT + ")");
try {
  // Hold the slow img's request open BEFORE the page loads (Network
  // interception). While held, the img has a real src but stays complete=false
  // — a true lazy-load state for the first viewport tile.
  trace("arm network interception");
  await cdp.send("Network.enable");
  await cdp.send("Network.setRequestInterception", {
    patterns: [{ urlPattern: "*img-red.png*" }]
  });
  trace("navigate to page");
  await cdp.navigate(`http://127.0.0.1:${HTTP_PORT}/harness/image-wait-page.html`);
  await cdp.sleep(400);
  // Load background.js into the page (classic script — it only registers listeners).
  trace("load background.js");
  await cdp.evalJs(`new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = ${JSON.stringify(BG_SRC_URL)};
    s.onload = () => { window.__pipeline.bgLoaded = true; res(true); };
    s.onerror = () => rej(new Error("background.js load failed"));
    document.head.appendChild(s);
  })`);
  trace("bg loaded");
  // Wait (deterministically) for the listener registration instead of a blind sleep.
  let pre = null;
  for (let i = 0; i < 40; i++) {
    pre = await cdp.evalJs(`({ bgLoaded: !!window.__pipeline.bgLoaded, hasListener: typeof window.__pipeline.listener, pipelineExists: !!window.__pipeline })`);
    if (pre.hasListener === "function") break;
    await cdp.sleep(100);
  }
  trace("pre-capture state: " + JSON.stringify(pre));
  if (pre?.hasListener !== "function") throw new Error("listener never registered");

  // Drain the intercepted img request (it fires during page load).
  let interceptionId = null;
  for (let i = 0; i < 50 && !interceptionId; i++) {
    const idx = cdp.events.findIndex((ev) => ev.method === "Network.requestIntercepted" && (ev.params?.request?.url || "").includes("img-red.png"));
    if (idx >= 0) {
      interceptionId = cdp.events[idx].params.interceptionId;
      cdp.events.splice(idx, 1);
    } else {
      await cdp.sleep(100);
    }
  }
  trace("interceptionId: " + (interceptionId ? "held" : "MISSING"));
  if (!interceptionId) throw new Error("img request was not intercepted");

  trace("start capture");
  const t0 = Date.now();
  // Fire the capture, release the img request ~300 ms in (mid-wait), then await.
  const capturePromise = cdp.evalJs(`(async () => {
    const sendResponse = (r) => { window.__pipeline.response = r; };
    window.__pipeline.listener({ type: "START_CAPTURE", mode: "full", tabId: 1, windowId: 1 }, {}, sendResponse);
    for (let i = 0; i < 200 && !window.__pipeline.response; i++) await new Promise((r) => setTimeout(r, 100));
    return window.__pipeline.response || { timedOut: true };
  })()`);
  await cdp.sleep(300);
  await cdp.send("Network.continueInterceptedRequest", { interceptionId });
  trace("img request released at +300ms");
  const captureResult = await capturePromise;
  const wallMs = Date.now() - t0;
  trace("capture response: " + JSON.stringify(captureResult));
  trace("wallMs: " + wallMs);

  const check = await cdp.evalJs(`(async () => {
    const stored = window.__pipeline.stored;
    if (!stored || !stored.latestCapture) return { ok: false, why: "no stored capture" };
    const blob = await (await fetch(stored.latestCapture.dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    const w = img.width, h = img.height;
    const px = (x, y) => { const i = (y * w + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
    // Row sequence along the left column x=0 (outside the img box).
    const rowSeq = [];
    for (let y = 0; y < h; y++) {
      const [r, g, b] = px(0, y);
      let found = -1;
      for (let ri = 0; ri < ${N_ROWS}; ri++) {
        if (r === ROW_COLORS[ri][0] && g === ROW_COLORS[ri][1] && b === ROW_COLORS[ri][2]) { found = ri; break; }
      }
      rowSeq.push(found);
    }
    const runs = [];
    for (let y = 0; y < rowSeq.length; y++) {
      const last = runs[runs.length - 1];
      if (last && last.row === rowSeq[y]) last.len++;
      else runs.push({ y, row: rowSeq[y], len: 1 });
    }
    return {
      ok: true, w, h,
      runs,
      imgPixel: px(${IMG.x + 10}, ${IMG.y + 10}),   // inside the loaded img box
      imgPixel2: px(${IMG.x + 60}, ${IMG.y + 60}),  // deeper inside
      outsidePixel: px(0, ${IMG.y + 40})            // left column, same y — must stay row color
    };
  })()`);
  log.push("stitch check: " + JSON.stringify(check));
  trace("stitch check: " + JSON.stringify(check));

  const counters = await cdp.evalJs(`({ cimb: window.__cimb, tabs: window.__pipeline.createdTabs, captures: window.__pipeline.captureCount, behaviors: window.__pipeline.behaviors, imageChecks: window.__pipeline.imageChecks, imgComplete: (() => { const i = document.getElementById("slowImg"); return i ? i.complete + "/" + i.naturalWidth : "missing"; })() })`);
  log.push("counters: " + JSON.stringify(counters));
  trace("counters: " + JSON.stringify(counters));

  // Assertions.
  const responseOk = captureResult?.ok === true;
  const tabOk = counters.tabs.length === 1 && counters.tabs[0] === "editor.html";
  const dimsOk = check?.w === 982 && check?.h === PAGE_H;
  // Q1: scroll-behavior forced to 'auto' at every capture, despite the page's
  // `scroll-behavior: smooth !important`.
  const guardOk = Array.isArray(counters.behaviors) && counters.behaviors.length > 0 && counters.behaviors.every((b) => b === "auto");
  // Q2: the stitch shows the loaded img (yellow box), not the blank placeholder.
  const [ir, ig, ib] = check?.imgPixel || [];
  const [ir2, ig2, ib2] = check?.imgPixel2 || [];
  const imgOk = ir === 220 && ig === 220 && ib === 30 && ir2 === 220 && ig2 === 220 && ib2 === 30;
  // Row sequence still exact along the left column.
  const expected = Array.from({ length: N_ROWS }, (_, r) => ({ row: r, len: ROW_H }));
  const seqOk = check?.runs && check.runs.length === expected.length && check.runs.every((run, i) => run.row === expected[i].row && run.len === expected[i].len);
  const closedAll = counters.cimb.closed === counters.cimb.created;

  const report = {
    kind: "image-wait",
    recordedAt: new Date().toISOString(),
    wallMs,
    response: captureResult,
    stitch: check,
    counters,
    assertions: { responseOk, tabOk, dimsOk, guardOk, imgOk, seqOk, closedAll }
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log.push("assertions: " + JSON.stringify(report.assertions));
  trace("assertions: " + JSON.stringify(report.assertions));

  const ok = responseOk && tabOk && dimsOk && guardOk && imgOk && seqOk && closedAll;
  console.log(log.join("\n"));
  console.log(ok ? "H5 PASS" : "H5 FAIL");
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(log.join("\n"));
  console.error("H5 DRIVER ERROR: " + e.message);
  process.exit(1);
} finally {
  cdp.close();
  stopChrome({ proc, userDataDir });
  server.close();
}
