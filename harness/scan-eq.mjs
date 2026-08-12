// H2 — Fixed-element scan equivalence + timing harness.
// Loads a synthetic ~20k-element page, runs (a) the OLD scan copied verbatim
// from background.js at T0 (embedded reference) and (b) the CURRENT scan
// extracted live from background.js, and compares hidden-node sets, returned
// metrics, and wall time. At T0 both are identical code (sanity); after T1 the
// extracted one is the new implementation — equivalence is the contract.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./lib/server.mjs";
import { launchChrome, stopChrome, findPageTarget, CDP, addInitScript } from "./lib/cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const HTTP_PORT = 8738;
const CDP_PORT = 9224;
const OUT = process.argv[2] || join(__dirname, "scan-report.json");

// --- Build the synthetic page: 20k+ elements, mix of fixed/sticky/plain ---
const N_PLAIN = 15000;
const N_INLINE_FIXED = 500;
const N_FX = 500;
const N_ST = 500;
const N_FX_PARENT = 100;
let idx = 0;
let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fx{position:fixed}.st{position:sticky}html,body{margin:0}</style></head><body>`;
for (let i = 0; i < N_PLAIN; i++) html += `<div data-i="${idx++}"></div>`;
for (let i = 0; i < N_INLINE_FIXED; i++) html += `<div data-i="${idx++}" style="position:fixed"></div>`;
for (let i = 0; i < N_FX; i++) html += `<div data-i="${idx++}" class="fx"></div>`;
for (let i = 0; i < N_ST; i++) html += `<div data-i="${idx++}" class="st"></div>`;
for (let i = 0; i < N_FX_PARENT; i++) {
  html += `<div data-i="${idx++}" class="fx"><div data-i="${idx++}" style="position:absolute"></div></div>`;
}
html += `<div data-i="${idx++}" style="position:relative"></div>`;
html += `<div data-i="${idx++}" style="position:absolute"></div>`;
html += `<div data-i="${idx++}"></div>`;
html += `</body></html>`;
writeFileSync(join(__dirname, "scan-page.html"), html);

// Expected hidden set: inline fixed + class fx + class st + fx parents (not
// the absolute children, not the relative/absolute/plain tail).
const EXPECTED_HIDDEN = new Set();
let e = 0;
for (let i = 0; i < N_PLAIN; i++) e++;
for (let i = 0; i < N_INLINE_FIXED; i++) EXPECTED_HIDDEN.add(e++);
for (let i = 0; i < N_FX; i++) EXPECTED_HIDDEN.add(e++);
for (let i = 0; i < N_ST; i++) EXPECTED_HIDDEN.add(e++);
for (let i = 0; i < N_FX_PARENT; i++) { EXPECTED_HIDDEN.add(e++); e++; } // parent hidden, child not

// --- OLD scan: verbatim copy from background.js at T0 (captureFullPage) ---
const OLD_SCAN = () => {
  const doc = document.documentElement;
  const body = document.body;

  document.querySelectorAll("*").forEach((node) => {
    const style = window.getComputedStyle(node);
    if ((style.position === "fixed" || style.position === "sticky") && !node.dataset.pagesnapHidden) {
      node.dataset.pagesnapHidden = node.style.visibility || "__EMPTY__";
      node.style.visibility = "hidden";
    }
  });

  return {
    fullWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth),
    fullHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    originalX: window.scrollX,
    originalY: window.scrollY
  };
};

// --- Extract the CURRENT scan func from background.js (the first `func: () => {`
//     after `async function captureFullPage`, brace-balanced) ---
function extractScanFunc(src) {
  const start = src.indexOf("async function captureFullPage");
  if (start < 0) throw new Error("captureFullPage not found in background.js");
  const slice = src.slice(start);
  const marker = "func: () => {";
  const m = slice.indexOf(marker);
  if (m < 0) throw new Error("scan func marker not found in captureFullPage");
  const i = m + "func: ".length; // at "() => {"
  const braceStart = slice.indexOf("{", i);
  let depth = 0;
  let j = braceStart;
  for (; j < slice.length; j++) {
    if (slice[j] === "{") depth++;
    else if (slice[j] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return slice.slice(i, j + 1);
}

const backgroundSrc = readFileSync(join(REPO_ROOT, "background.js"), "utf8");
const CURRENT_SCAN_SRC = extractScanFunc(backgroundSrc);

const server = await startServer(REPO_ROOT, HTTP_PORT);
const { proc, userDataDir } = launchChrome({ port: CDP_PORT });
const page = await findPageTarget(CDP_PORT, "about:blank");
const cdp = await CDP.connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const URL = `http://127.0.0.1:${HTTP_PORT}/harness/scan-page.html`;

async function runScan(scanExpr, reps = 3) {
  const results = [];
  for (let r = 0; r < reps; r++) {
    await cdp.navigate(URL);
    await cdp.sleep(400);
    const res = await cdp.evalJs(`(() => {
      const t0 = performance.now();
      const m = (${scanExpr})();
      const dt = performance.now() - t0;
      const hidden = [...document.querySelectorAll("[data-pagesnap-hidden]")].map((n) => +n.dataset.i).sort((a, b) => a - b);
      return { dt, metrics: m, hidden };
    })()`);
    results.push(res);
  }
  return results;
}

const log = [];
try {
  const oldResults = await runScan(OLD_SCAN.toString());
  const newResults = await runScan(CURRENT_SCAN_SRC);

  // Equivalence: every rep must hide exactly the expected set, with equal metrics.
  const expectedArr = [...EXPECTED_HIDDEN].sort((a, b) => a - b);
  const eqChecks = [];
  for (const [name, results] of [["old", oldResults], ["new", newResults]]) {
    for (let r = 0; r < results.length; r++) {
      const res = results[r];
      const hiddenEq = JSON.stringify(res.hidden) === JSON.stringify(expectedArr);
      const metricsOk =
        typeof res.metrics.fullWidth === "number" &&
        typeof res.metrics.fullHeight === "number" &&
        typeof res.metrics.viewportWidth === "number" &&
        typeof res.metrics.viewportHeight === "number";
      eqChecks.push({ name, rep: r, hiddenEq, metricsOk, hiddenCount: res.hidden.length, dt: res.dt });
      log.push(`${name} rep${r}: hiddenEq=${hiddenEq} (count ${res.hidden.length}/${expectedArr.length}), metricsOk=${metricsOk}, dt=${res.dt.toFixed(1)}ms`);
    }
  }

  const hiddenEq = eqChecks.every((c) => c.hiddenEq);
  const metricsOk = eqChecks.every((c) => c.metricsOk);
  // Both implementations must agree with each other AND with the expected set.
  const oldHidden = JSON.stringify(oldResults[0].hidden);
  const newHidden = JSON.stringify(newResults[0].hidden);
  const oldNewAgree = oldHidden === newHidden;

  const oldDts = oldResults.map((r) => r.dt);
  const newDts = newResults.map((r) => r.dt);
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const oldMed = median(oldDts);
  const newMed = median(newDts);

  const report = {
    kind: "scan-eq",
    recordedAt: new Date().toISOString(),
    page: { elements: idx, expectedHidden: expectedArr.length },
    oldTimingsMs: oldDts,
    newTimingsMs: newDts,
    medianOldMs: oldMed,
    medianNewMs: newMed,
    speedup: oldMed / newMed,
    equivalence: { hiddenEq, metricsOk, oldNewAgree }
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  log.push(`median old ${oldMed.toFixed(1)}ms vs new ${newMed.toFixed(1)}ms (x${(oldMed / newMed).toFixed(2)})`);
  log.push("saved: " + OUT);

  const ok = hiddenEq && metricsOk && oldNewAgree;
  console.log(log.join("\n"));
  console.log(ok ? "H2 PASS" : "H2 FAIL");
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(log.join("\n"));
  console.log("H2 DRIVER ERROR: " + e.message);
  process.exit(1);
} finally {
  cdp.close();
  stopChrome({ proc, userDataDir });
  server.close();
}
